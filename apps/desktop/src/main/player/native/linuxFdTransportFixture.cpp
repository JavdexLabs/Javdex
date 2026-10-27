#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <fcntl.h>
#include <poll.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "linuxFdTransport.h"

namespace {
using namespace javdex_transport;
constexpr int kChannelFd = 3;

bool Send(const std::string& payload, std::size_t fd_count) {
  std::vector<int> descriptors;
  for (std::size_t i = 0; i < fd_count; ++i) {
    int fd = ::memfd_create("javdex-transport-fixture-NOT-DMABUF", MFD_CLOEXEC);
    if (fd < 0) {
      for (int owned : descriptors) ::close(owned);
      return false;
    }
    const std::string marker = "memfd transport fixture; not a DMA-BUF\n";
    if (::write(fd, marker.data(), marker.size()) != static_cast<ssize_t>(marker.size())) {
      ::close(fd);
      for (int owned : descriptors) ::close(owned);
      return false;
    }
    descriptors.push_back(fd);
  }
  iovec iov{const_cast<char*>(payload.data()), payload.size()};
  msghdr message{};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  std::vector<unsigned char> control;
  if (!descriptors.empty()) {
    control.resize(CMSG_SPACE(sizeof(int) * descriptors.size()));
    message.msg_control = control.data();
    message.msg_controllen = control.size();
    cmsghdr* header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int) * descriptors.size());
    std::memcpy(CMSG_DATA(header), descriptors.data(), sizeof(int) * descriptors.size());
  }
  ssize_t size;
  do { size = ::sendmsg(kChannelFd, &message, MSG_NOSIGNAL); } while (size < 0 && errno == EINTR);
  int error = errno;
  for (int fd : descriptors) ::close(fd);
  if (size != static_cast<ssize_t>(payload.size())) {
    std::cerr << "fixture send failed: " << std::strerror(error) << '\n';
    return false;
  }
  return true;
}

bool SendSealed() {
  const int fd = ::memfd_create("javdex-sealed-cpu-frame", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (fd < 0) return false;
  constexpr std::size_t kBytes = 4096;
  std::vector<unsigned char> bytes(kBytes, 0xA5);
  if (::ftruncate(fd, static_cast<off_t>(kBytes)) != 0
      || ::pwrite(fd, bytes.data(), kBytes, 0) != static_cast<ssize_t>(kBytes)
      || ::fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW) != 0) {
    std::cerr << "sealed memfd setup failed: " << std::strerror(errno) << '\n';
    ::close(fd);
    return false;
  }
  const std::string metadata = R"({"type":"sealed-cpu-frame","bytes":4096})";
  iovec iov{const_cast<char*>(metadata.data()), metadata.size()};
  const int descriptor = fd;
  std::vector<unsigned char> control(CMSG_SPACE(sizeof(int)));
  msghdr message{};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = control.data();
  message.msg_controllen = control.size();
  cmsghdr* header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  std::memcpy(CMSG_DATA(header), &descriptor, sizeof(descriptor));
  ssize_t size;
  do { size = ::sendmsg(kChannelFd, &message, MSG_NOSIGNAL); } while (size < 0 && errno == EINTR);
  const int error = errno;
  ::close(fd);
  if (size != static_cast<ssize_t>(metadata.size())) {
    std::cerr << "sealed send failed: " << std::strerror(error) << '\n';
    return false;
  }
  return true;
}

bool WaitAck(std::uint64_t expected) {
  pollfd wait{kChannelFd, POLLIN, 0};
  int ready;
  do { ready = ::poll(&wait, 1, 5000); } while (ready < 0 && errno == EINTR);
  if (ready <= 0) { std::cerr << "fixture timed out waiting for ACK\n"; return false; }
  std::array<std::uint8_t, kAckBytes + 1> packet{};
  ssize_t size = ::recv(kChannelFd, packet.data(), packet.size(), 0);
  std::uint64_t sequence;
  if (size < 0 || !DecodeAck(packet.data(), static_cast<std::size_t>(size), &sequence) ||
      sequence != expected) {
    std::cerr << "fixture invalid ACK\n";
    return false;
  }
  return true;
}
}  // namespace

int main(int argc, char** argv) {
  const std::string mode = argc > 1 ? argv[1] : "valid";
  if (mode == "eof") return 0;
  if (mode == "drain-acks") {
    // The parent fills the nonblocking send queue before spawning this reader.
    // Drain until its final marker, making writable readiness observable.
    for (;;) {
      pollfd wait{kChannelFd, POLLIN, 0};
      if (::poll(&wait, 1, 5000) <= 0) return 1;
      std::array<std::uint8_t, kAckBytes> packet{};
      const auto size = ::recv(kChannelFd, packet.data(), packet.size(), 0);
      std::uint64_t sequence = 0;
      if (size <= 0 || !DecodeAck(packet.data(), static_cast<std::size_t>(size), &sequence)) return 1;
      if (sequence == 1) return 0;
    }
  }
  if (mode == "sealed") return SendSealed() && WaitAck(1) ? 0 : 1;
  if (mode == "valid" || mode == "send-only") {
    const std::string metadata = R"({"type":"transport-fixture","sequence":"18446744073709551615","isDmaBuf":false})";
    if (!Send(metadata, 1)) return 1;
    if (mode == "send-only") return 0;
    if (!WaitAck(UINT64_MAX)) return 1;
    std::cout << "ACK verified; producer-owned memfd closed after SCM_RIGHTS send\n";
    return 0;
  }
  if (mode == "missing") return Send("missing fd", 0) ? 0 : 1;
  if (mode == "empty-fd") return Send("", 1) ? 0 : 1;
  if (mode == "extra") return Send("too many fds", 2) ? 0 : 1;
  if (mode == "ctrunc") return Send("truncated control", 40) ? 0 : 1;
  if (mode == "trunc") return Send(std::string(kMaxMetadata + 1, 'x'), 1) ? 0 : 1;
  if (mode == "both-trunc") return Send(std::string(kMaxMetadata + 1, 'x'), 40) ? 0 : 1;
  std::cerr << "unknown fixture mode: " << mode << '\n';
  return 2;
}
