#pragma once

// Bounded CPU frame storage, leases and private transport. No graphics APIs.
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "linuxFdTransport.h"
#include <array>
#include <algorithm>
#include <sys/mman.h>
#include <sys/stat.h>
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

namespace javdex::cpu {
constexpr size_t slotCount = 3;
constexpr uint64_t maxSequence = 9007199254740991ULL;
constexpr int maxWidth = 1280, maxHeight = 720;
constexpr uint64_t maxBufferBytes = uint64_t(maxWidth) * maxHeight * 4;
constexpr uint64_t frameIntervalMs = 34; // Never more than 30 full renders/second.
constexpr uint64_t stallTimeoutMs = 5000;
constexpr int maxDimension = 100000;
constexpr size_t maxMessage = 8 * 1024 * 1024 + 4096;
constexpr int transportFd = 3;
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
    if (fields.front() != "occlusions" && count > 16) throw std::runtime_error("Invalid playback command fields");
    return fields;
}
inline double finiteNumber(const std::string &text) {
    size_t length = 0; const double value = std::stod(text, &length);
    if (length != text.size() || !std::isfinite(value)) throw std::runtime_error("Expected finite playback number");
    return value;
}
struct Dimensions { int width, height; };
inline Dimensions dimensions(double width, double height, double scale) {
    if (!std::isfinite(width) || !std::isfinite(height) || !std::isfinite(scale)
        || width <= 0 || height <= 0 || width > maxDimension || height > maxDimension
        || scale <= 0 || scale > 8) throw std::runtime_error("Invalid CPU frame dimensions");
    const double w = width * scale, h = height * scale;
    const double factor = std::min({1.0, maxWidth / w, maxHeight / h});
    return {std::max(1, static_cast<int>(std::floor(w * factor))),
        std::max(1, static_cast<int>(std::floor(h * factor)))};
}
inline Bounds rectangle(const std::vector<std::string> &fields, size_t offset) {
    Bounds value{finiteNumber(fields.at(offset)), finiteNumber(fields.at(offset + 1)), finiteNumber(fields.at(offset + 2)),
        finiteNumber(fields.at(offset + 3)), finiteNumber(fields.at(offset + 4))};
    if (std::abs(value.x) > 100000 || std::abs(value.y) > 100000) throw std::runtime_error("Invalid playback rectangle");
    dimensions(value.width, value.height, value.scale);
    return value;
}
inline size_t bufferSize(int width, int height) {
    if (width < 1 || height < 1 || width > maxWidth || height > maxHeight)
        throw std::runtime_error("Invalid CPU frame buffer layout");
    return size_t(width) * 4 * size_t(height);
}
// A slot is writable only before publication or after the matching ACK. Resize
// replaces an unleased slot; it never mutates the extent behind a received FD.
class Buffer {
public:
    int fd = -1, width = 0, height = 0;
    size_t stride = 0, size = 0;
    void *pixels = nullptr;
    Buffer() = default;
    Buffer(const Buffer &) = delete;
    Buffer &operator=(const Buffer &) = delete;
    ~Buffer() { release(); }
    void release() noexcept {
        if (pixels) munmap(pixels, size);
        if (fd >= 0) close(fd);
        fd = -1; pixels = nullptr; width = height = 0; stride = size = 0;
    }
    void prepare(int w, int h) {
        const auto bytes = bufferSize(w, h);
        if (pixels && width == w && height == h) return;
        release();
        fd = memfd_create("javdex-cpu-frame", MFD_CLOEXEC | MFD_ALLOW_SEALING);
        if (fd < 0 || ftruncate(fd, static_cast<off_t>(bytes)) < 0)
            throw std::runtime_error("Cannot allocate CPU frame storage");
        if (fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL) < 0)
            throw std::runtime_error("Cannot seal CPU frame storage extent");
        void *mapping = mmap(nullptr, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (mapping == MAP_FAILED) throw std::runtime_error("Cannot map CPU frame storage");
        pixels = mapping; size = bytes; width = w; height = h; stride = size_t(w) * 4;
    }
    void makeOpaque() {
        auto *bytes = static_cast<unsigned char *>(pixels);
        for (size_t i = 3; i < size; i += 4) bytes[i] = 255;
    }
};
inline bool validFrameFile(int fd, size_t size) {
    if (!size || size > maxBufferBytes) return false;
    struct stat status{};
    if (fstat(fd, &status) != 0 || !S_ISREG(status.st_mode)
        || status.st_size != static_cast<off_t>(size)) return false;
    const int seals = fcntl(fd, F_GET_SEALS);
    return seals >= 0 && (seals & (F_SEAL_SHRINK | F_SEAL_GROW)) == (F_SEAL_SHRINK | F_SEAL_GROW);
}
// Visibility and consumer pressure are independent of the CPU. A hidden or
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
    std::array<uint64_t, slotCount> pending{}, publishedAt{};
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
        if (sequence >= maxSequence) throw std::runtime_error("CPU frame frame sequence exhausted");
        return sequence + 1;
    }
    void publish(size_t slot, uint64_t value, uint64_t timestamp = 0) {
        if (slot >= slotCount || pending[slot] || value != next()) throw std::runtime_error("Invalid CPU frame frame lease");
        pending[slot] = value; publishedAt[slot] = timestamp; sequence = value;
    }
    void acknowledge(uint64_t value) {
        if (!value || value > maxSequence) throw std::runtime_error("Invalid CPU frame acknowledgement");
        for (auto &entry : pending) if (entry == value) { entry = 0; return; }
        throw std::runtime_error("Unknown CPU frame acknowledgement");
    }
    void restartDeadline(uint64_t timestamp) {
        for (size_t i = 0; i < slotCount; i++) if (pending[i]) publishedAt[i] = timestamp;
    }
    bool expired(uint64_t timestamp) const {
        for (size_t i = 0; i < slotCount; i++)
            if (pending[i] && timestamp >= publishedAt[i] && timestamp - publishedAt[i] >= stallTimeoutMs) return true;
        return false;
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
        throw std::runtime_error("Private CPU frame socketpair is unavailable");
    // Anonymous socketpair endpoints have no pathname or abstract socket name.
    if (localLength > sizeof(sa_family_t) || peerLength > sizeof(sa_family_t))
        throw std::runtime_error("CPU frame transport must be an anonymous socketpair");
    const int flags = fcntl(fd, F_GETFL), descriptorFlags = fcntl(fd, F_GETFD);
    if (flags < 0 || descriptorFlags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0
        || fcntl(fd, F_SETFD, descriptorFlags | FD_CLOEXEC) < 0)
        throw std::runtime_error("Cannot configure CPU frame transport");
}
inline bool sendFrame(int socket, const std::string &metadata, int descriptor) {
    if (metadata.empty() || metadata.size() > javdex_transport::kMaxMetadata || descriptor < 0)
        throw std::runtime_error("Invalid CPU frame frame packet");
    iovec io{const_cast<char *>(metadata.data()), metadata.size()};
    alignas(cmsghdr) unsigned char control[CMSG_SPACE(sizeof(int))]{};
    msghdr message{}; message.msg_iov = &io; message.msg_iovlen = 1;
    message.msg_control = control; message.msg_controllen = sizeof(control);
    auto *header = CMSG_FIRSTHDR(&message); header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int)); std::memcpy(CMSG_DATA(header), &descriptor, sizeof(descriptor));
    ssize_t result;
    do { result = sendmsg(socket, &message, MSG_DONTWAIT | MSG_NOSIGNAL); } while (result < 0 && errno == EINTR);
    if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return false;
    if (result != static_cast<ssize_t>(metadata.size())) throw std::runtime_error("CPU frame consumer disconnected");
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
        if (count < 0) throw std::runtime_error("CPU frame acknowledgement read failed");
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
            throw std::runtime_error(count == 0 ? "CPU frame consumer disconnected" : "Invalid CPU frame acknowledgement packet");
        leases.acknowledge(sequence); received++;
    }
    return received;
}
} // namespace javdex::cpu
