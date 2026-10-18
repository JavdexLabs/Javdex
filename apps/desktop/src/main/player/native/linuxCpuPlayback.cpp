// Opt-in libmpv software renderer. Frames are written to bounded memfd slots;
// no OpenGL, EGL, GBM, DRM node, or native window is initialized.
#define JAVDEX_STANDALONE_PLAYBACK
#include "mpvCore.h"
#include "linuxCpuFrame.h"
#include "linuxCpuFonts.h"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <poll.h>
#include <signal.h>
#include <sys/eventfd.h>
#include <sys/prctl.h>
#include <sys/stat.h>

namespace {
using namespace javdex;
using namespace javdex::cpu;
MpvCore playback;
Leases leases;
Bounds requested;
bool rendererControls = true;
PublicationState publication;
std::string presentation = "expanded";
int wakeFd = -1, pixelWidth = 1, pixelHeight = 1;
uint64_t now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void wake(void *) {
    const uint64_t value = 1;
    // eventfd is nonblocking; a saturated counter already guarantees a wake.
    // No mpv calls are allowed from this callback.
    if (wakeFd >= 0) { ssize_t written; do { written = write(wakeFd, &value, sizeof(value)); } while (written < 0 && errno == EINTR); }
}
std::array<Buffer, slotCount> buffers;
uint32_t generation = 1;
uint64_t resumeAfterCommand = 0, generationStartedAt = 0, nextRenderAt = 0;
bool waitingForRestart = false;
int preparedSlot = -1;
std::string preparedMetadata;
uint64_t preparedSequence = 0;
void destroyPlayer() {
    // Received descriptors keep storage alive; exiting never reuses a lease.
    playback.shutdown();
    for (auto &buffer : buffers) buffer.release();
    preparedSlot = -1; preparedMetadata.clear(); publication.setVisible(false);
}
void updateBounds(const Bounds &rect) {
    const auto size = dimensions(rect.width, rect.height, rect.scale);
    const int width = size.width, height = size.height;
    requested = rect;
    if (width != pixelWidth || height != pixelHeight) {
        pixelWidth = width; pixelHeight = height; publication.request();
        // Unsent work has no consumer ownership, so it can be replaced by the
        // newest viewport. Its sequence was not committed to the lease pool.
        preparedSlot = -1; preparedMetadata.clear();
    }
}
void create(const Bounds &rect) {
    if (playback.alive()) throw std::runtime_error("CPU frame playback is already initialized");
    updateBounds(rect);
    playback.initializeSoftware(subtitleFontDirectory(), wake);
    publication.request();
}
bool dispatch(const std::vector<std::string> &fields) {
    const auto &op = fields.at(0);
    if (op == "create" && fields.size() == 8 && fields[1] == "0" && fields[7] == "cpu") create(rectangle(fields, 2));
    else if (op == "destroy" && fields.size() == 1) { destroyPlayer(); return false; }
    else if (!playback.alive()) throw std::runtime_error("No CPU frame playback session");
    else if (op == "generation" && fields.size() == 2) {
        const double value = finiteNumber(fields[1]);
        if (value < 1 || value > UINT32_MAX || std::floor(value) != value) throw std::runtime_error("Invalid CPU frame generation");
        generation = static_cast<uint32_t>(value);
        preparedSlot = -1; preparedMetadata.clear();
        playback.drainEvents();
        resumeAfterCommand = playback.mediaCommandSerial() + 1;
        generationStartedAt = now(); waitingForRestart = true;
        publication.request();
    }
    else if (op == "bounds" && fields.size() == 6) updateBounds(rectangle(fields, 1));
    else if (op == "renderer-controls" && fields.size() == 2 && (fields[1] == "0" || fields[1] == "1")) rendererControls = fields[1] == "1";
    else if (op == "occlusions" && fields.size() <= 257 && (fields.size() - 1) % 8 == 0) {
        // Renderer composition handles occlusion; still validate the wire input.
        for (size_t i = 1; i < fields.size(); i++) if (std::abs(finiteNumber(fields[i])) > 100000)
            throw std::runtime_error("Invalid playback occlusion");
    } else if (op == "visible" && fields.size() == 2 && (fields[1] == "0" || fields[1] == "1")) { if (fields[1] == "1" && !publication.visible()) leases.restartDeadline(now());
        publication.setVisible(fields[1] == "1"); }
    else if (op == "presentation" && fields.size() == 2 && (fields[1] == "expanded" || fields[1] == "docked" || fields[1] == "fullscreen")) presentation = fields[1];
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
    return "{\"protocol\":\"javdex-cpu-frame-v1\",\"sequence\":" + std::to_string(sequence) + ",\"slot\":" + std::to_string(slot)
        + ",\"generation\":" + std::to_string(generation)
        + ",\"width\":" + std::to_string(buffer.width) + ",\"height\":" + std::to_string(buffer.height)
        + ",\"pixelFormat\":\"rgba\",\"stride\":" + std::to_string(buffer.stride)
        + ",\"size\":" + std::to_string(buffer.size) + ",\"producerComplete\":true}";
}
void skipUpdate(bool updated) {
    if (updated) {
        if (!playback.skipRender()) throw std::runtime_error("libmpv could not skip a CPU frame");
        playback.swapped();
    }
}
void render() {
    if (!playback.alive()) return;
    const bool updated = playback.updateRequested();
    if (updated) publication.request();
    if (waitingForRestart && playback.mediaCommandReady(resumeAfterCommand)) {
        waitingForRestart = false; publication.request();
    }
    if (waitingForRestart && now() - generationStartedAt >= 30000)
        throw std::runtime_error("CPU frame timeline transition timed out");
    if (!publication.visible() || waitingForRestart) {
        preparedSlot = -1; preparedMetadata.clear(); publication.stalled(false, now());
        skipUpdate(updated); publication.request(); return;
    }
    if (leases.expired(now())) throw std::runtime_error("CPU frame consumer stalled waiting for release");
    if (!publication.pending() && preparedSlot < 0) { publication.stalled(false, now()); return; }
    bool rendered = false;
    if (preparedSlot < 0 && now() >= nextRenderAt) {
        const int slot = leases.available();
        if (slot >= 0) {
            auto &buffer = buffers[slot]; buffer.prepare(pixelWidth, pixelHeight);
            const auto renderStarted = now();
            if (!playback.renderSoftware(pixelWidth, pixelHeight, buffer.stride, buffer.pixels))
                throw std::runtime_error("libmpv could not render the CPU frame");
            buffer.makeOpaque(); nextRenderAt = renderStarted + frameIntervalMs;
            rendered = true; preparedSlot = slot; preparedSequence = leases.next();
            preparedMetadata = metadata(buffer, slot, preparedSequence); publication.consumed();
        }
    }
    if (preparedSlot >= 0 && sendFrame(transportFd, preparedMetadata, buffers[preparedSlot].fd)) {
        leases.publish(preparedSlot, preparedSequence, now()); playback.swapped();
        preparedSlot = -1; preparedMetadata.clear(); publication.stalled(false, now()); return;
    }
    // Keep the decoder/audio clock moving while throttled or waiting for slots.
    // Only a subsequent full render may touch a slot, and only once it is free.
    if (!rendered) skipUpdate(updated);
    const bool blocked = preparedSlot >= 0 || leases.available() < 0;
    if (publication.stalled(blocked, now())) throw std::runtime_error("CPU frame consumer stalled waiting for release");
}
std::string state() {
    auto result = playback.stateJson(); result.pop_back();
    return result + ",\"backend\":\"linux-cpu\",\"pixelWidth\":" + std::to_string(pixelWidth) + ",\"pixelHeight\":" + std::to_string(pixelHeight)
        + ",\"rendererFullscreenControls\":" + (rendererControls ? "true" : "false") + ",\"nativeVideoFocused\":false"
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
        nonblocking(STDIN_FILENO); nonblocking(STDOUT_FILENO); validateTransport(transportFd);
        wakeFd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
        if (wakeFd < 0) throw std::runtime_error("Cannot create playback wakeup event");
        std::string input; uint64_t lastState = 0; bool running = true;
        while (running) {
            pollfd channels[] = {{STDIN_FILENO, POLLIN, 0}, {transportFd, static_cast<short>(POLLIN | (preparedSlot >= 0 ? POLLOUT : 0)), 0},
                {wakeFd, POLLIN, 0}, {STDOUT_FILENO, static_cast<short>(output.pending() ? POLLOUT : 0), 0}};
            int timeout = 16;
            if (publication.visible() && publication.pending() && !waitingForRestart
                && preparedSlot < 0 && leases.available() >= 0) {
                const auto timestamp = now();
                timeout = nextRenderAt <= timestamp ? 0 : static_cast<int>(std::min<uint64_t>(16, nextRenderAt - timestamp));
            }
            const int ready = poll(channels, 4, timeout);
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
