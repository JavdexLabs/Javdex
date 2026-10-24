#pragma once
#include "renderConfig.h"

// Shared invariants for the experimental producer. This header does not create
// a GPU buffer; the socket tests exercise ownership and framing, not GPU import.
#include "linuxFdTransport.h"
#include <array>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

namespace javdex::dmabuf {
constexpr size_t slotCount = 3;
constexpr uint64_t maxSequence = 9007199254740991ULL;
constexpr uint64_t maxBufferBytes = maximumFrameBytes;
constexpr uint64_t stallTimeoutMs = 5000;
constexpr int maxDimension = maximumFrameDimension;
constexpr size_t maxMessage = 8 * 1024 * 1024 + 4096;
constexpr int transportFd = 3;
// NVIDIA block-linear GBM/EGL and Vulkan imports can disagree when the
// requested block is taller than the image. Select a smaller advertised
// layout before allocation; never rewrite an allocated buffer's modifier.
// This is an interop selection policy, not a DRM modifier validity check.
inline bool compatibleVulkanBlockHeight(uint64_t modifier, int height) {
    if (height < 1) return false;
    if ((modifier >> 56) != 0x03 || !(modifier & 0x10)) return true;
    const unsigned generation = (modifier >> 20) & 3;
    const unsigned logHeight = modifier & 0xf;
    if (generation == 3 || logHeight > 5) return true; // Unknown layout: do not reinterpret it.
    const unsigned gobHeight = generation == 1 ? 4 : 8;
    const unsigned blockHeight = gobHeight << logHeight;
    return logHeight == 0 || blockHeight <= static_cast<unsigned>(height);
}

struct Bounds { double x = 0, y = 0, width = 1, height = 1, scale = 1; };
inline uint32_t read32(const std::string &bytes, size_t offset) {
    if (offset > bytes.size() || bytes.size() - offset < 4) throw std::runtime_error("Truncated playback command");
    const auto *p = reinterpret_cast<const unsigned char *>(bytes.data() + offset);
    return p[0] | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
inline std::vector<std::string> decode(const std::string &bytes) {
    const auto count = read32(bytes, 0);
    if (!count || count > 257) throw std::runtime_error("Invalid playback command fields");
    std::vector<std::string> fields; size_t offset = 4;
    for (uint32_t i = 0; i < count; i++) {
        const auto length = read32(bytes, offset); offset += 4;
        if (length > maxMessage || offset > bytes.size() || length > bytes.size() - offset)
            throw std::runtime_error("Invalid playback field length");
        fields.push_back(bytes.substr(offset, length)); offset += length;
        if (fields.back().find('\0') != std::string::npos) throw std::runtime_error("Invalid playback field");
    }
    if (offset != bytes.size()) throw std::runtime_error("Trailing playback command bytes");
    if (count > 16) throw std::runtime_error("Invalid playback command fields");
    return fields;
}
inline double finiteNumber(const std::string &text) {
    size_t length = 0; const double value = std::stod(text, &length);
    if (length != text.size() || !std::isfinite(value)) throw std::runtime_error("Expected finite playback number");
    return value;
}
inline int pixels(double logical, double scale) {
    const double result = std::round(logical * scale);
    if (!std::isfinite(result) || result < 1 || result > maxDimension)
        throw std::runtime_error("DMA-BUF viewport exceeds supported dimensions");
    return static_cast<int>(result);
}
inline Bounds rectangle(const std::vector<std::string> &fields, size_t offset) {
    Bounds value{finiteNumber(fields.at(offset)), finiteNumber(fields.at(offset + 1)), finiteNumber(fields.at(offset + 2)),
        finiteNumber(fields.at(offset + 3)), finiteNumber(fields.at(offset + 4))};
    if (value.width <= 0 || value.height <= 0 || std::abs(value.x) > 100000 || std::abs(value.y) > 100000
        || value.scale <= 0 || value.scale > 8) throw std::runtime_error("Invalid playback rectangle");
    pixels(value.width, value.scale); pixels(value.height, value.scale);
    return value;
}
inline uint64_t bufferSize(int width, int height, uint32_t stride, uint32_t offset) {
    if (width < 1 || height < 1 || width > maxDimension || height > maxDimension || stride < uint64_t(width) * 4)
        throw std::runtime_error("Invalid DMA-BUF buffer layout");
    const uint64_t size = uint64_t(offset) + uint64_t(stride) * uint64_t(height);
    if (size > maxBufferBytes || stride > static_cast<uint32_t>(std::numeric_limits<int32_t>::max())
        || offset > static_cast<uint32_t>(std::numeric_limits<int32_t>::max()))
        throw std::runtime_error("DMA-BUF buffer exceeds allocation limit");
    return size;
}
// Visibility and consumer pressure are independent of the GPU. A hidden or
// not-yet-bound renderer cannot exhaust leases or accrue a stall timeout.
class PublicationState {
    bool shown = false, wanted = false, waiting = false;
    uint64_t waitingSince = 0;
public:
    void setVisible(bool value) { shown = value; wanted = true; if (!value) waiting = false; }
    bool visible() const { return shown; }
    void request() { wanted = true; }
    bool pending() const { return wanted; }
    void consumed() { wanted = false; }
    bool stalled(bool blocked, uint64_t timestamp) {
        if (!shown || !blocked) { waiting = false; return false; }
        if (!waiting) { waiting = true; waitingSince = timestamp; return false; }
        return timestamp >= waitingSince && timestamp - waitingSince >= stallTimeoutMs;
    }
};
class Leases {
    std::array<uint64_t, slotCount> pending{};
    uint64_t sequence = 0;
public:
    int available() const {
        for (size_t i = 0; i < slotCount; i++) if (!pending[i]) return static_cast<int>(i);
        return -1;
    }
    size_t inFlight() const {
        size_t result = 0; for (const auto value : pending) if (value) result++; return result;
    }
    uint64_t next() const {
        if (sequence >= maxSequence) throw std::runtime_error("DMA-BUF frame sequence exhausted");
        return sequence + 1;
    }
    void publish(size_t slot, uint64_t value) {
        if (slot >= slotCount || pending[slot] || value != next()) throw std::runtime_error("Invalid DMA-BUF frame lease");
        pending[slot] = value; sequence = value;
    }
    void acknowledge(uint64_t value) {
        if (!value || value > maxSequence) throw std::runtime_error("Invalid DMA-BUF acknowledgement");
        for (auto &entry : pending) if (entry == value) { entry = 0; return; }
        throw std::runtime_error("Unknown DMA-BUF acknowledgement");
    }
    uint64_t latest() const { return sequence; }
};
inline void validateTransport(int fd) {
    int type = 0; socklen_t length = sizeof(type);
    sockaddr_storage local{}, peer{}; socklen_t localLength = sizeof(local), peerLength = sizeof(peer);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_SEQPACKET
        || getsockname(fd, reinterpret_cast<sockaddr *>(&local), &localLength)
        || getpeername(fd, reinterpret_cast<sockaddr *>(&peer), &peerLength)
        || local.ss_family != AF_UNIX || peer.ss_family != AF_UNIX)
        throw std::runtime_error("Private DMA-BUF socketpair is unavailable");
    // Anonymous socketpair endpoints have no pathname or abstract socket name.
    if (localLength > sizeof(sa_family_t) || peerLength > sizeof(sa_family_t))
        throw std::runtime_error("DMA-BUF transport must be an anonymous socketpair");
    const int flags = fcntl(fd, F_GETFL), descriptorFlags = fcntl(fd, F_GETFD);
    if (flags < 0 || descriptorFlags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0
        || fcntl(fd, F_SETFD, descriptorFlags | FD_CLOEXEC) < 0)
        throw std::runtime_error("Cannot configure DMA-BUF transport");
}
inline bool sendFrame(int socket, const std::string &metadata, int descriptor) {
    if (metadata.empty() || metadata.size() > javdex_transport::kMaxMetadata || descriptor < 0)
        throw std::runtime_error("Invalid DMA-BUF frame packet");
    iovec io{const_cast<char *>(metadata.data()), metadata.size()};
    alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(int))]{};
    msghdr message{}; message.msg_iov = &io; message.msg_iovlen = 1;
    message.msg_control = control; message.msg_controllen = sizeof(control);
    auto *header = CMSG_FIRSTHDR(&message); header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int)); std::memcpy(CMSG_DATA(header), &descriptor, sizeof(descriptor));
    ssize_t result;
    do { result = sendmsg(socket, &message, MSG_DONTWAIT | MSG_NOSIGNAL); } while (result < 0 && errno == EINTR);
    if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return false;
    if (result != static_cast<ssize_t>(metadata.size())) throw std::runtime_error("DMA-BUF consumer disconnected");
    return true;
}
inline size_t drainAcknowledgements(int socket, Leases &leases) {
    size_t received = 0;
    // Bounded drain keeps malformed/flooded input from starving mpv and stdio.
    for (size_t i = 0; i < 64; i++) {
        uint8_t bytes[javdex_transport::kAckBytes]{};
        alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(int) * javdex_transport::kMaxReceivedDescriptors)]{};
        iovec io{bytes, sizeof(bytes)}; msghdr message{};
        message.msg_iov = &io; message.msg_iovlen = 1; message.msg_control = control; message.msg_controllen = sizeof(control);
        const auto count = recvmsg(socket, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
        if (count < 0 && errno == EINTR) { i--; continue; }
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        if (count < 0) throw std::runtime_error("DMA-BUF acknowledgement read failed");
        bool ancillary = false;
        for (auto *header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
            ancillary = true;
            if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS && header->cmsg_len >= CMSG_LEN(0)) {
                const size_t descriptors = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
                for (size_t j = 0; j < descriptors; j++) { int fd; std::memcpy(&fd, CMSG_DATA(header) + j * sizeof(int), sizeof(fd)); close(fd); }
            }
        }
        uint64_t sequence = 0;
        if (ancillary || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC))
            || !javdex_transport::DecodeAck(bytes, count, &sequence))
            throw std::runtime_error(count == 0 ? "DMA-BUF consumer disconnected" : "Invalid DMA-BUF acknowledgement packet");
        leases.acknowledge(sequence); received++;
    }
    return received;
}
} // namespace javdex::dmabuf
