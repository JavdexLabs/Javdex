#include "linuxDmaBuf.h"
#include <cassert>
#include <functional>
#include <chrono>
#include <iostream>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <sys/un.h>
#ifdef NDEBUG
#error Native regressions require assertions enabled
#endif
using namespace javdex::dmabuf;
namespace {
bool rejects(const std::function<void()> &operation) {
    try { operation(); } catch (const std::exception &) { return true; } return false;
}
void append32(std::string &out, uint32_t value) { for (unsigned i = 0; i < 4; i++) out.push_back((value >> (i * 8)) & 255); }
std::string encode(const std::vector<std::string> &fields) {
    std::string bytes; append32(bytes, fields.size());
    for (const auto &field : fields) { append32(bytes, field.size()); bytes += field; }
    return bytes;
}
void ack(int fd, uint64_t sequence) {
    uint8_t bytes[javdex_transport::kAckBytes]; javdex_transport::EncodeAck(bytes, sequence);
    assert(send(fd, bytes, sizeof(bytes), MSG_NOSIGNAL) == sizeof(bytes));
}
struct ChildResult { int status; std::string output; };
ChildResult helperFailure(const char *helper, bool socket, const std::vector<std::string> &fields) {
    int input[2], output[2], pair[2];
    assert(pipe2(input, O_CLOEXEC) == 0); assert(pipe2(output, O_CLOEXEC) == 0);
    assert(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) == 0);
    const auto child = fork(); assert(child >= 0);
    if (!child) {
        assert(dup2(input[0], STDIN_FILENO) == STDIN_FILENO); assert(dup2(output[1], STDOUT_FILENO) == STDOUT_FILENO);
        if (socket) assert(dup2(pair[1], transportFd) == transportFd); else close(transportFd);
        for (const int fd : {input[0], input[1], output[0], output[1], pair[0], pair[1]}) if (fd > transportFd) close(fd);
        setenv("JAVDEX_DRM_RENDER_NODE", "/dev/dri/javdex-test-missing-render-node", 1);
        execl(helper, helper, "--stdio-v1", nullptr); _exit(127);
    }
    close(input[0]); close(output[1]); close(pair[1]);
    std::string command; const auto body = encode(fields); append32(command, body.size()); command += body;
    if (socket) assert(write(input[1], command.data(), command.size()) == static_cast<ssize_t>(command.size()));
    close(input[1]);
    assert(fcntl(output[0], F_SETFL, O_NONBLOCK) == 0);
    int status = 0; bool exited = false; std::string text;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (std::chrono::steady_clock::now() < deadline) {
        pollfd event{output[0], POLLIN, 0}; poll(&event, 1, 10);
        char bytes[4096]; ssize_t size;
        while ((size = read(output[0], bytes, sizeof(bytes))) > 0) text.append(bytes, size);
        assert(text.size() <= 65536);
        if (waitpid(child, &status, WNOHANG) == child) { exited = true; break; }
        if (event.revents & POLLHUP) usleep(1000); // EOF can precede process exit; avoid a busy poll.
    }
    if (!exited) { kill(child, SIGKILL); waitpid(child, &status, 0); }
    close(output[0]); close(pair[0]); assert(exited); assert(WIFEXITED(status));
    return {WEXITSTATUS(status), text};
}
}
int main(int argc, char **argv) {
    assert(pixels(100.25, 2) == 201); assert(pixels(1, 1) == 1);
    assert(rejects([] { pixels(8192, 2); })); assert(rejects([] { pixels(0.1, 1); }));
    assert(rejects([] { pixels(std::numeric_limits<double>::infinity(), 1); }));
    const std::vector<std::string> fields{"create", "0", "0", "0", "800", "450", "1.25", "dmabuf"};
    assert(decode(encode(fields)) == fields);
    const auto bounds = rectangle(fields, 2); assert(pixels(bounds.width, bounds.scale) == 1000);
    assert(rejects([] { decode(""); })); assert(rejects([&] { decode(encode(fields) + 'x'); }));
    assert(rejects([] { decode(encode({"command", std::string("a\0b", 3)})); }));
    assert(rejects([] { finiteNumber("1x"); })); assert(rejects([] { finiteNumber("nan"); }));
    assert(rejects([] { rectangle({"0", "0", "1", "1", "9"}, 0); }));
    assert(bufferSize(100, 50, 448, 64) == 22464);
    assert(rejects([] { bufferSize(100, 50, 399, 0); }));
    assert(rejects([] { bufferSize(8192, 8192, UINT32_MAX, 0); }));
    assert(rejects([] { bufferSize(8193, 1, 65536, 0); }));
    PublicationState publication;
    assert(!publication.visible()); publication.request(); assert(publication.pending());
    assert(!publication.stalled(true, 100)); assert(!publication.stalled(true, 60100));
    publication.setVisible(true); assert(publication.pending()); publication.consumed(); assert(!publication.pending());
    assert(!publication.stalled(true, 60200)); assert(!publication.stalled(true, 65199)); assert(publication.stalled(true, 65200));
    publication.setVisible(false); assert(publication.pending());
    assert(!publication.stalled(true, 90000)); assert(!publication.stalled(true, 900000));
    publication.setVisible(true); assert(publication.pending());
    assert(!publication.stalled(true, 900000)); assert(!publication.stalled(true, 904999));
    assert(!publication.stalled(false, 905000)); assert(!publication.stalled(true, 905000));
    assert(publication.stalled(true, 910000));
    Leases leases; assert(leases.available() == 0); assert(leases.inFlight() == 0);
    leases.publish(0, 1); leases.publish(1, 2); leases.publish(2, 3);
    assert(leases.available() == -1); assert(leases.inFlight() == 3);
    assert(rejects([&] { leases.publish(0, 4); }));
    assert(rejects([&] { leases.acknowledge(0); })); assert(rejects([&] { leases.acknowledge(4); }));
    leases.acknowledge(2); assert(leases.available() == 1);
    leases.publish(1, 4); assert(rejects([&] { leases.acknowledge(2); }));
    assert(rejects([&] { leases.publish(3, 5); }));
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) == 0);
    validateTransport(pair[0]); validateTransport(pair[1]);
    assert(fcntl(pair[0], F_GETFL) & O_NONBLOCK); assert(fcntl(pair[0], F_GETFD) & FD_CLOEXEC);
    ack(pair[1], 1); ack(pair[1], 4); assert(drainAcknowledgements(pair[0], leases) == 2);
    assert(leases.inFlight() == 1); assert(drainAcknowledgements(pair[0], leases) == 0);
    ack(pair[1], 1); assert(rejects([&] { drainAcknowledgements(pair[0], leases); }));
    uint8_t bad[javdex_transport::kAckBytes + 1]{}; javdex_transport::EncodeAck(bad, 3);
    assert(send(pair[1], bad, sizeof(bad), 0) == sizeof(bad));
    assert(rejects([&] { drainAcknowledgements(pair[0], leases); }));
    bad[4] = 2; assert(send(pair[1], bad, sizeof(bad) - 1, 0) == sizeof(bad) - 1);
    assert(rejects([&] { drainAcknowledgements(pair[0], leases); }));
    const int file = memfd_create("javdex-transport-test", MFD_CLOEXEC); assert(file >= 0);
    assert(write(file, "test", 4) == 4);
    assert(sendFrame(pair[0], "{\"test\":true}", file));
    char data[64]{}; alignas(cmsghdr) char control[CMSG_SPACE(sizeof(int))]{};
    iovec io{data, sizeof(data)}; msghdr message{}; message.msg_iov = &io; message.msg_iovlen = 1;
    message.msg_control = control; message.msg_controllen = sizeof(control);
    assert(recvmsg(pair[1], &message, MSG_CMSG_CLOEXEC) == 13); assert(std::string(data, 13) == "{\"test\":true}");
    const auto *header = CMSG_FIRSTHDR(&message); assert(header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS);
    int received = -1; std::memcpy(&received, CMSG_DATA(header), sizeof(received)); assert(received >= 0);
    close(file); assert(pread(received, data, 4, 0) == 4); assert(std::string(data, 4) == "test");
    // Even valid ACK payloads may not transfer descriptors. The drain must
    // close unexpected received handles before rejecting the packet.
    javdex_transport::EncodeAck(bad, 3);
    assert(sendFrame(pair[1], std::string(reinterpret_cast<char *>(bad), javdex_transport::kAckBytes), received));
    assert(rejects([&] { drainAcknowledgements(pair[0], leases); }));
    close(received); close(pair[1]); assert(rejects([&] { drainAcknowledgements(pair[0], leases); })); close(pair[0]);
    assert(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) == 0);
    assert(rejects([&] { validateTransport(pair[0]); })); close(pair[0]); close(pair[1]);
    assert(rejects([] { validateTransport(-1); }));
    if (argc == 2) {
        const auto unavailable = helperFailure(argv[1], true, fields);
        assert(unavailable.status == 1);
        assert(unavailable.output.find("Cannot open DRM render node") != std::string::npos);
        assert(unavailable.output.find("javdex-test-missing-render-node") == std::string::npos);
        assert(unavailable.output.find("\"alive\":false") != std::string::npos);
        const auto noSocket = helperFailure(argv[1], false, fields);
        assert(noSocket.status == 1); assert(noSocket.output.find("Private DMA-BUF socketpair is unavailable") != std::string::npos);
        auto invalid = fields; invalid[1] = "123";
        const auto invalidCreate = helperFailure(argv[1], true, invalid);
        assert(invalidCreate.status == 1); assert(invalidCreate.output.find("No shared-texture playback session") != std::string::npos);
    }
    std::cout << "DMA-BUF layout, protocol and 3-slot lease tests passed (no GPU acceptance)\n";
}
