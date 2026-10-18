#include "linuxCpuFrame.h"
#include "linuxCpuFonts.h"
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
using namespace javdex::cpu;
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

}
int main() {
    assert(fontDirectoryForExecutable("/opt/javdex/playback-cpu-helper") == "/opt/javdex/fonts");
    assert(fontDirectoryForExecutable("/playback-cpu-helper") == "/fonts");
    assert(rejects([] { fontDirectoryForExecutable("playback-cpu-helper"); }));
    assert(rejects([] { fontDirectoryForExecutable("/opt/javdex/"); }));
    char directory[] = "/tmp/javdex-cpu-font-XXXXXX";
    assert(mkdtemp(directory));
    const std::string font = std::string(directory) + "/NotoSans-Regular.ttf";
    assert(!validSubtitleFont(directory));
    int fontFd = open(font.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    assert(fontFd >= 0);
    const unsigned char sfnt[] = {0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
    assert(write(fontFd, sfnt, sizeof(sfnt)) == sizeof(sfnt)); close(fontFd);
    assert(validSubtitleFont(directory));
    fontFd = open(font.c_str(), O_WRONLY | O_TRUNC | O_CLOEXEC); assert(fontFd >= 0);
    assert(write(fontFd, "wOF2invalid!", 12) == 12); close(fontFd);
    assert(!validSubtitleFont(directory));
    assert(unlink(font.c_str()) == 0); assert(symlink("/dev/zero", font.c_str()) == 0);
    assert(!validSubtitleFont(directory));
    assert(unlink(font.c_str()) == 0); assert(mkdir(font.c_str(), 0700) == 0);
    assert(!validSubtitleFont(directory));
    assert(rmdir(font.c_str()) == 0); assert(rmdir(directory) == 0);
    const auto small = dimensions(100.25, 50, 2); assert(small.width == 200 && small.height == 100);
    const auto large = dimensions(3840, 2160, 2); assert(large.width == 1280 && large.height == 720);
    const auto portrait = dimensions(1080, 1920, 1); assert(portrait.width == 405 && portrait.height == 720);
    const auto wide = dimensions(2560, 1080, 1); assert(wide.width == 1280 && wide.height == 540);
    assert(dimensions(0.1, 0.1, 1).width == 1);
    assert(rejects([] { dimensions(0, 1, 1); }));
    assert(rejects([] { dimensions(std::numeric_limits<double>::infinity(), 1, 1); }));
    assert(rejects([] { dimensions(1, 1, std::numeric_limits<double>::quiet_NaN()); }));
    const std::vector<std::string> fields{"create", "0", "0", "0", "800", "450", "1.25", "cpu"};
    assert(decode(encode(fields)) == fields);
    const auto bounds = rectangle(fields, 2); assert(dimensions(bounds.width, bounds.height, bounds.scale).width == 1000);
    assert(rejects([] { decode(""); })); assert(rejects([&] { decode(encode(fields) + 'x'); }));
    assert(rejects([] { decode(encode({"command", std::string("a\0b", 3)})); }));
    assert(rejects([] { finiteNumber("1x"); })); assert(rejects([] { finiteNumber("nan"); }));
    assert(rejects([] { rectangle({"0", "0", "1", "1", "9"}, 0); }));
    assert(bufferSize(1280, 720) == maxBufferBytes);
    assert(rejects([] { bufferSize(1281, 720); })); assert(rejects([] { bufferSize(1, 721); }));
    assert(rejects([] { bufferSize(0, 1); }));
    Buffer buffer; buffer.prepare(320, 180);
    assert(buffer.stride == 1280 && buffer.size == 320 * 180 * 4);
    assert(validFrameFile(buffer.fd, buffer.size));
    assert(!validFrameFile(buffer.fd, buffer.size - 1)); assert(!validFrameFile(-1, buffer.size));
    assert(!validFrameFile(buffer.fd, 0)); assert(!validFrameFile(buffer.fd, maxBufferBytes + 1));
    assert(ftruncate(buffer.fd, buffer.size - 1) == -1 && errno == EPERM);
    assert(ftruncate(buffer.fd, buffer.size + 1) == -1 && errno == EPERM);
    std::memset(buffer.pixels, 17, buffer.size); buffer.makeOpaque();
    auto *pixel = static_cast<unsigned char *>(buffer.pixels);
    assert(pixel[0] == 17 && pixel[1] == 17 && pixel[2] == 17 && pixel[3] == 255);
    assert(pixel[buffer.size - 1] == 255);
    const int retained = dup(buffer.fd); assert(retained >= 0);
    buffer.prepare(1280, 720); assert(validFrameFile(buffer.fd, maxBufferBytes));
    unsigned char previous[4]{}; assert(pread(retained, previous, 4, 0) == 4);
    assert(previous[0] == 17 && previous[3] == 255); // old received extent survives resize
    close(retained); buffer.release(); buffer.release();
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
    leases.publish(0, 1, 100); leases.publish(1, 2, 101); leases.publish(2, 3, 102);
    assert(!leases.expired(5099)); assert(leases.expired(5100));
    leases.restartDeadline(9000); assert(!leases.expired(13999)); assert(leases.expired(14000));
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
    std::cout << "CPU frame extent, geometry, protocol and 3-slot leases passed (no playback claim)\n";
}
