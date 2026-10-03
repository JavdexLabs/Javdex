// Private stdio v1 transport. No sockets, shell commands, or renderer access.
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/prctl.h>
#include <cerrno>
#include <iostream>
#include <limits>

namespace {
constexpr size_t maxMessage = 1024 * 1024;
uint32_t read32(const std::string &bytes, size_t offset) {
    if (offset + 4 > bytes.size()) throw std::runtime_error("Truncated playback command");
    const auto *p = reinterpret_cast<const unsigned char *>(bytes.data() + offset);
    return p[0] | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
std::vector<std::string> decode(const std::string &bytes) {
    const auto count = read32(bytes, 0);
    if (!count || count > 16) throw std::runtime_error("Invalid playback command fields");
    std::vector<std::string> fields; size_t offset = 4;
    for (uint32_t i = 0; i < count; i++) {
        const auto length = read32(bytes, offset); offset += 4;
        if (length > maxMessage || offset + length > bytes.size()) throw std::runtime_error("Invalid playback field length");
        fields.push_back(bytes.substr(offset, length)); offset += length;
        if (fields.back().find('\0') != std::string::npos) throw std::runtime_error("Invalid playback field");
    }
    if (offset != bytes.size()) throw std::runtime_error("Trailing playback command bytes");
    return fields;
}
double finiteNumber(const std::string &text) {
    size_t length = 0; const double value = std::stod(text, &length);
    if (length != text.size() || !std::isfinite(value)) throw std::runtime_error("Expected finite playback number");
    return value;
}
Bounds rectangle(const std::vector<std::string> &fields, size_t offset) {
    Bounds value{finiteNumber(fields.at(offset)), finiteNumber(fields.at(offset + 1)), finiteNumber(fields.at(offset + 2)),
        finiteNumber(fields.at(offset + 3)), finiteNumber(fields.at(offset + 4))};
    if (value.width <= 0 || value.height <= 0 || value.width > 100000 || value.height > 100000
        || std::abs(value.x) > 100000 || std::abs(value.y) > 100000 || value.scale <= 0 || value.scale > 8)
        throw std::runtime_error("Invalid playback rectangle");
    return value;
}
bool dispatch(const std::vector<std::string> &fields) {
    const auto &op = fields.at(0);
    if (op == "create" && fields.size() == 8 && fields[7] == "x11") {
        size_t length = 0; const auto handle = std::stoull(fields[1], &length);
        if (length != fields[1].size() || !handle || handle > UINT32_MAX) throw std::runtime_error("Invalid X11 parent");
        create(static_cast<Window>(handle), rectangle(fields, 2));
    } else if (op == "bounds" && fields.size() == 6) bounds(rectangle(fields, 1));
    else if (op == "visible" && fields.size() == 2 && (fields[1] == "0" || fields[1] == "1")) setVisible(fields[1] == "1");
    else if (op == "presentation" && fields.size() == 2) setPresentation(fields[1]);
    else if (op == "command" && fields.size() >= 2 && fields.size() <= 9) playback.command({fields.begin() + 1, fields.end()});
    else if (op == "destroy" && fields.size() == 1) { destroyPlayer(); return false; }
    else throw std::runtime_error("Invalid playback operation");
    return true;
}
void emit(const std::string &message) {
    const std::string bytes = message + '\n'; size_t offset = 0;
    while (offset < bytes.size()) {
        const auto count = write(STDOUT_FILENO, bytes.data() + offset, bytes.size() - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) throw std::runtime_error("Playback host disconnected");
        offset += static_cast<size_t>(count);
    }
}
}
int main(int argc, char **argv) {
    if (argc != 2 || std::string(argv[1]) != "--stdio-v1") return 2;
    // Children must not outlive an unexpectedly terminated application.
    const auto host = getppid();
    if (host == 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != host) return 2;
    if (fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK) < 0) return 2;
    std::string input; uint64_t lastState = 0;
    try {
        bool running = true;
        while (running) {
            pollfd channel{STDIN_FILENO, POLLIN, 0};
            const auto ready = poll(&channel, 1, 16);
            if (ready < 0 && errno != EINTR) throw std::runtime_error("Playback input failed");
            if (ready > 0) {
                char buffer[16384];
                while (true) {
                    const auto count = ::read(STDIN_FILENO, buffer, sizeof(buffer));
                    if (!count) { running = false; break; }
                    if (count < 0) { if (errno == EINTR) continue; if (errno == EAGAIN) break; throw std::runtime_error("Playback input disconnected"); }
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
            playback.drainEvents(); render();
            if (now() - lastState >= 50) { emit(state()); lastState = now(); }
        }
        destroyPlayer(); return 0;
    } catch (const std::exception &error) {
        try { emit("{\"alive\":false,\"error\":" + javdex::jsonString(error.what()) + ",\"errorKind\":\"native\"}"); } catch (...) {}
        try { destroyPlayer(); } catch (...) {}
        return 1;
    }
}
