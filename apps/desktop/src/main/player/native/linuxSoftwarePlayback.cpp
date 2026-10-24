// CPU-only libmpv producer. No display, EGL, GBM, DRM or GPU imports.
#define JAVDEX_STANDALONE_PLAYBACK
#include "mpvCore.h"
#include "linuxDmaBuf.h"
#include "frameTiming.h"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <poll.h>
#include <signal.h>
#include <sys/eventfd.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <dirent.h>
namespace {
// Electron may own descriptors without CLOEXEC. Retain only stdio and the
// explicitly inherited private channel before libmpv creates any threads.
void closeInheritedDescriptors() {
#ifdef SYS_close_range
    if (syscall(SYS_close_range, 4U, ~0U, 0U) == 0) return;
#endif
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) throw std::runtime_error("Cannot isolate CPU helper descriptors");
    const int own = dirfd(directory);
    while (const auto *entry = readdir(directory)) {
        char *end = nullptr;
        const long descriptor = std::strtol(entry->d_name, &end, 10);
        if (end != entry->d_name && !*end && descriptor > 3 && descriptor != own) close(static_cast<int>(descriptor));
    }
    closedir(directory);
}
using namespace javdex;
using namespace javdex::dmabuf;
MpvCore playback;
Leases leases;
Bounds requested;
PublicationState publication;
int wakeFd = -1, pixelWidth = 1, pixelHeight = 1;
uint64_t now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void wake(void *) {
    const uint64_t value = 1;
    // eventfd is nonblocking; a saturated counter already guarantees a wake.
    // No mpv calls are allowed from this callback.
    if (wakeFd >= 0) { ssize_t written; do { written = write(wakeFd, &value, sizeof(value)); } while (written < 0 && errno == EINTR); }
}
struct Buffer {
    int fd = -1, width = 0, height = 0;
    size_t stride = 0, size = 0;
    unsigned char *data = nullptr;
};
class CpuBuffers {
    std::array<Buffer, slotCount> buffers{};
    void release(Buffer &b) {
        if (b.data) munmap(b.data, b.size);
        if (b.fd >= 0) close(b.fd);
        b = {};
    }
public:
    void shutdown() { for (auto &b : buffers) release(b); }
    Buffer &prepare(int slot, int width, int height) {
        auto &b = buffers.at(slot);
        if (b.width == width && b.height == height) return b;
        release(b);
        b.width = width; b.height = height; b.stride = (size_t(width) * 4 + 63) & ~size_t(63);
        b.size = b.stride * height;
        if (b.size > maxBufferBytes) throw std::runtime_error("CPU frame exceeds memory limit");
        b.fd = memfd_create("javdex-cpu-frame", MFD_CLOEXEC | MFD_ALLOW_SEALING);
        if (b.fd < 0 || ftruncate(b.fd, b.size) != 0
            || fcntl(b.fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL) != 0)
            throw std::runtime_error("Cannot allocate CPU frame");
        void *mapped = mmap(nullptr, b.size, PROT_READ | PROT_WRITE, MAP_SHARED, b.fd, 0);
        if (mapped == MAP_FAILED) throw std::runtime_error("Cannot map CPU frame");
        b.data = static_cast<unsigned char *>(mapped); return b;
    }
    void finish(Buffer &b) {
        // mpv's rgb0 has undefined alpha. Canvas requires opaque RGBA.
        for (int y = 0; y < b.height; y++)
            for (int x = 0; x < b.width; x++) b.data[y * b.stride + x * 4 + 3] = 255;
    }
} buffers;
int preparedSlot = -1;
std::string preparedMetadata;
uint64_t preparedSequence = 0;
FrameTiming frameTiming;
void destroyPlayer() {
    // Destroy never reuses outstanding memory. The host owns its copied pixels.
    playback.shutdown(); buffers.shutdown();
    preparedSlot = -1; preparedMetadata.clear(); publication.setVisible(false);
}
void updateBounds(const Bounds &rect) {
    const auto layout = frameLayout(rect.width, rect.height, rect.scale);
    const int width = layout.width, height = layout.height;
    requested = rect;
    if (width != pixelWidth || height != pixelHeight) {
        pixelWidth = width; pixelHeight = height; publication.request();
        // Unsent work has no consumer ownership, so it can be replaced by the
        // newest viewport. Its sequence was not committed to the lease pool.
        preparedSlot = -1; preparedMetadata.clear();
    }
}
void create(const Bounds &rect) {
    if (playback.alive()) throw std::runtime_error("CPU playback is already initialized");
    updateBounds(rect);
    RenderConfig config; config.cpu = true; config.hardwareDecode = "no"; config.wakeup = wake;
    playback.initialize(config);
    publication.request();
}
bool dispatch(const std::vector<std::string> &fields) {
    const auto &op = fields.at(0);
    if (op == "create" && fields.size() == 7 && fields[6] == "software") create(rectangle(fields, 1));
    else if (op == "destroy" && fields.size() == 1) { destroyPlayer(); return false; }
    else if (op == "diagnostic-stall" && fields.size() == 1 && std::getenv("JAVDEX_PLAYBACK_DIAGNOSTICS") && std::string(std::getenv("JAVDEX_PLAYBACK_DIAGNOSTICS")) == "1") { for (;;) pause(); }
    else if (op == "timing-reset" && fields.size() == 2) {
        const double value = finiteNumber(fields[1]);
        if (value < 1 || value > maxSequence || std::floor(value) != value) throw std::runtime_error("Invalid timing epoch");
        frameTiming.reset(static_cast<uint64_t>(value));
        preparedSlot = -1; preparedMetadata.clear(); publication.request();
    }
    else if (!playback.alive()) throw std::runtime_error("No CPU playback session");
    else if (op == "bounds" && fields.size() == 6) updateBounds(rectangle(fields, 1));
    else if (op == "visible" && fields.size() == 2 && (fields[1] == "0" || fields[1] == "1")) { publication.setVisible(fields[1] == "1"); }

    else if ((op == "command" || op == "generated-subtitle-command") && fields.size() >= 2 && fields.size() <= 9)
        playback.command({fields.begin() + 1, fields.end()}, op == "generated-subtitle-command");
    else if (op == "generated-subtitles" && fields.size() == 5 && (fields[3] == "0" || fields[3] == "1")) {
        const double revision = finiteNumber(fields[4]);
        if (revision < 1 || revision > maxSequence || std::floor(revision) != revision) throw std::runtime_error("Invalid subtitle revision");
        playback.generatedSubtitles(fields[1], fields[2], fields[3] == "1", static_cast<uint64_t>(revision));
    } else throw std::runtime_error("Invalid playback operation");
    return true;
}
std::string metadata(const Buffer &buffer, int slot, uint64_t sequence) {
    return "{\"protocol\":\"javdex-cpu-v1\",\"sequence\":" + std::to_string(sequence) + ",\"slot\":" + std::to_string(slot)
        + ",\"width\":" + std::to_string(buffer.width) + ",\"height\":" + std::to_string(buffer.height)
        + frameTiming.metadata()
        + ",\"pixelFormat\":\"rgba\",\"colorContract\":\"bt709-srgb-rgb-full\",\"stride\":" + std::to_string(buffer.stride)
        + ",\"size\":" + std::to_string(buffer.size) + '}';
}
void render() {
    if (!playback.alive()) return;
    // Always pump mpv, even when the consumer has all slots or socket pressure
    // prevents publication. A requested frame remains pending across polls.
    const bool updated = playback.updateRequested();
    if (updated) publication.request();
    if (!publication.visible()) {
        // Hidden/unbound surfaces have no consumer. Discard unsent work and
        // consume mpv updates without leasing memory or accumulating a timeout.
        preparedSlot = -1; preparedMetadata.clear(); publication.stalled(false, now());
        if (updated) {
            if (!playback.skipRender()) throw std::runtime_error("libmpv could not skip a hidden frame");
            // Skipping does not supply optional physical swap feedback.
        }
        publication.request();
        return;
    }
    if (!publication.pending() && preparedSlot < 0) { publication.stalled(false, now()); return; }
    bool rendered = false;
    if (preparedSlot < 0) {
        const int slot = leases.available();
        if (slot >= 0) {
            auto &buffer = buffers.prepare(slot, pixelWidth, pixelHeight);
            const auto delay = playback.nextFrameDelayUs();
            frameTiming.sample(linuxFrameClockUs(), delay);
            if (!playback.renderSoftware(pixelWidth, pixelHeight, buffer.stride, buffer.data))
                throw std::runtime_error("libmpv could not render CPU pixels");
            buffers.finish(buffer); rendered = true; preparedSlot = slot; preparedSequence = leases.next();
            preparedMetadata = metadata(buffer, slot, preparedSequence); publication.consumed();
        }
    }
    if (preparedSlot >= 0) {
        auto &buffer = buffers.prepare(preparedSlot, pixelWidth, pixelHeight);
        if (sendFrame(transportFd, preparedMetadata, buffer.fd)) {
            leases.publish(preparedSlot, preparedSequence);
            // Publication is not proof that the canvas reached the display.
            preparedSlot = -1; preparedMetadata.clear(); publication.stalled(false, now()); return;
        }
    }
    if (updated && !rendered) {
        // The consumer owns all writable slots (or an earlier packet is waiting
        // for socket space). Drop this queued mpv frame rather than block its
        // playback clock; redraw demand still points at the newest frame.
        if (!playback.skipRender()) throw std::runtime_error("libmpv could not skip a backpressured frame");
        // No display swap occurred; keep the mpv render clock independent of IPC.
    }
    if (publication.stalled(true, now())) throw std::runtime_error("CPU frame consumer stalled waiting for frame release");
}
std::string state() {
    auto result = playback.stateJson(); result.pop_back();
    return result + ",\"backend\":\"linux-software\",\"pixelWidth\":" + std::to_string(pixelWidth) + ",\"pixelHeight\":" + std::to_string(pixelHeight)
        + ",\"exportedFrames\":" + std::to_string(leases.latest()) + ",\"cpuFramesInFlight\":" + std::to_string(leases.inFlight()) + '}';
}
class Output {
    std::string bytes;
    uint64_t blocked = 0;
public:
    bool pending() const { return !bytes.empty(); }
    void emit(const std::string &message) {
        if (bytes.size() + message.size() > 1024 * 1024) throw std::runtime_error("Playback state output overflow");
        bytes += message + '\n'; flush();
    }
    void flush() {
        while (!bytes.empty()) {
            const auto count = write(STDOUT_FILENO, bytes.data(), bytes.size());
            if (count < 0 && errno == EINTR) continue;
            if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                if (!blocked) blocked = now();
                if (now() - blocked >= stallTimeoutMs) throw std::runtime_error("Playback state consumer stalled");
                return;
            }
            if (count <= 0) throw std::runtime_error("Playback host disconnected");
            bytes.erase(0, static_cast<size_t>(count)); blocked = 0;
        }
    }
};
void nonblocking(int fd) {
    const int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) throw std::runtime_error("Cannot configure playback pipe");
}
} // namespace
int main(int argc, char **argv) {
    if (argc != 2 || std::string(argv[1]) != "--stdio-v1") return 2;
    const auto host = getppid();
    if (host == 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != host) return 2;
    signal(SIGPIPE, SIG_IGN);
    Output output;
    try {
        closeInheritedDescriptors();
        nonblocking(STDIN_FILENO); nonblocking(STDOUT_FILENO); validateTransport(transportFd);
        wakeFd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
        if (wakeFd < 0) throw std::runtime_error("Cannot create playback wakeup event");
        std::string input; uint64_t lastState = 0; bool running = true;
        while (running) {
            pollfd channels[] = {{STDIN_FILENO, POLLIN, 0}, {transportFd, static_cast<short>(POLLIN | (preparedSlot >= 0 ? POLLOUT : 0)), 0},
                {wakeFd, POLLIN, 0}, {STDOUT_FILENO, static_cast<short>(output.pending() ? POLLOUT : 0), 0}};
            const int ready = poll(channels, 4, 16);
            if (ready < 0 && errno != EINTR) throw std::runtime_error("Playback input failed");
            if (channels[0].revents & (POLLIN | POLLHUP)) {
                char buffer[16384];
                // Bounded reads allow mpv and the ACK channel to make progress
                // even while receiving a large generated subtitle document.
                for (size_t reads = 0; reads < 64; reads++) {
                    const auto count = read(STDIN_FILENO, buffer, sizeof(buffer));
                    if (!count) { running = false; break; }
                    if (count < 0) { if (errno == EINTR) { reads--; continue; } if (errno == EAGAIN || errno == EWOULDBLOCK) break; throw std::runtime_error("Playback input disconnected"); }
                    input.append(buffer, static_cast<size_t>(count));
                    while (input.size() >= 4) {
                        const auto length = read32(input, 0);
                        if (length < 4 || length > maxMessage) throw std::runtime_error("Invalid playback message length");
                        if (input.size() < length + 4) break;
                        running = dispatch(decode(input.substr(4, length))); input.erase(0, length + 4);
                        if (!running) break;
                    }
                    if (input.size() > maxMessage + 4) throw std::runtime_error("Playback input overflow");
                    if (!running) break;
                }
            }
            if (!running) break;
            if (channels[0].revents & (POLLERR | POLLNVAL)) throw std::runtime_error("Playback input disconnected");
            if (channels[1].revents & (POLLERR | POLLNVAL | POLLHUP)) throw std::runtime_error("CPU frame consumer disconnected");
            if (channels[1].revents & POLLIN) drainAcknowledgements(transportFd, leases);
            if (channels[2].revents & POLLIN) { uint64_t value; while (read(wakeFd, &value, sizeof(value)) == sizeof(value)) {} }
            playback.drainEvents(); render(); output.flush();
            if (now() - lastState >= 50) { output.emit(state()); lastState = now(); }
        }
        destroyPlayer(); close(wakeFd); wakeFd = -1; close(transportFd); return 0;
    } catch (const std::exception &error) {
        // Only our fixed diagnostics and libmpv error names reach this channel;
        // media command arguments, URLs and native device paths are never echoed.
        try { output.emit("{\"alive\":false,\"error\":" + javdex::jsonString(error.what()) + ",\"errorKind\":\"native\"}"); } catch (...) {}
        try { destroyPlayer(); } catch (...) {}
        if (wakeFd >= 0) close(wakeFd);
        wakeFd = -1; close(transportFd); return 1;
    }
}
