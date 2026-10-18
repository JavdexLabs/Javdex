#ifndef __linux__
#error "The private FD bridge is Linux-only."
#endif

#include <node_api.h>
#include <sys/socket.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <new>
#include <set>
#include <string>

#include "linuxFdTransport.h"

namespace {
using namespace javdex_transport;

struct State {
  std::set<int> owned;
  std::set<int> parents;
};

// On Linux, never retry close(2) after EINTR: the descriptor may already have
// been released and reused. Ownership leaves the addon before close is called.
void CloseOwned(State* state, int fd) {
  state->parents.erase(fd);
  state->owned.erase(fd);
  ::close(fd);
}

void Cleanup(void* data) {
  auto* state = static_cast<State*>(data);
  for (int fd : state->owned) ::close(fd);
  delete state;
}

napi_value Error(napi_env env, const char* code, const std::string& text) {
  napi_throw_error(env, code, text.c_str());
  return nullptr;
}

napi_value SystemError(napi_env env, const char* operation, int error) {
  return Error(env, "ERR_FD_BRIDGE_IO", std::string(operation) + ": " + std::strerror(error));
}

bool Check(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, "ERR_FD_BRIDGE_NAPI", "N-API operation failed");
  return false;
}

bool GetFd(napi_env env, napi_value value, int* out) {
  napi_valuetype type;
  double number;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number) ||
      number < 0 || number > INT_MAX || std::floor(number) != number) {
    napi_throw_type_error(env, "ERR_FD_BRIDGE_FD", "fd must be a nonnegative integer");
    return false;
  }
  *out = static_cast<int>(number);
  return true;
}

bool GetSequence(napi_env env, napi_value value, std::uint64_t* out) {
  napi_valuetype type;
  if (!Check(env, napi_typeof(env, value, &type))) return false;
  if (type == napi_bigint) {
    bool lossless = false;
    if (!Check(env, napi_get_value_bigint_uint64(env, value, out, &lossless))) return false;
    if (lossless) return true;
  } else if (type == napi_number) {
    double number;
    if (!Check(env, napi_get_value_double(env, value, &number))) return false;
    if (std::isfinite(number) && number >= 0 && number <= 9007199254740991.0 &&
        std::floor(number) == number) {
      *out = static_cast<std::uint64_t>(number);
      return true;
    }
  }
  napi_throw_type_error(env, "ERR_FD_BRIDGE_SEQUENCE", "sequence must be a uint64 bigint or nonnegative safe integer");
  return false;
}

bool Args(napi_env env, napi_callback_info info, std::size_t count,
          napi_value* argv, State** state) {
  std::size_t argc = count;
  void* data = nullptr;
  if (!Check(env, napi_get_cb_info(env, info, &argc, argv, nullptr, &data))) return false;
  *state = static_cast<State*>(data);
  if (argc < count) {
    napi_throw_type_error(env, "ERR_FD_BRIDGE_ARGUMENTS", "Missing required argument");
    return false;
  }
  return true;
}

bool ParentFd(napi_env env, State* state, napi_value value, int* fd) {
  if (!GetFd(env, value, fd)) return false;
  if (!state->parents.count(*fd)) {
    napi_throw_error(env, "ERR_FD_BRIDGE_OWNERSHIP", "Descriptor is not an open parent channel owned by this addon");
    return false;
  }
  return true;
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result;
  if (!Check(env, napi_get_boolean(env, value, &result))) return nullptr;
  return result;
}

napi_value CreateChannel(napi_env env, napi_callback_info info) {
  State* state;
  if (!Args(env, info, 0, nullptr, &state)) return nullptr;
  int sockets[2];
  if (::socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) < 0)
    return SystemError(env, "socketpair", errno);
  state->owned.insert(sockets[0]);
  state->owned.insert(sockets[1]);
  state->parents.insert(sockets[0]);
  napi_value result, parent, child;
  if (!Check(env, napi_create_object(env, &result)) ||
      !Check(env, napi_create_int32(env, sockets[0], &parent)) ||
      !Check(env, napi_create_int32(env, sockets[1], &child)) ||
      !Check(env, napi_set_named_property(env, result, "parentFd", parent)) ||
      !Check(env, napi_set_named_property(env, result, "childFd", child))) {
    CloseOwned(state, sockets[0]);
    CloseOwned(state, sockets[1]);
    return nullptr;
  }
  return result;
}

napi_value Receive(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  State* state;
  int fd;
  if (!Args(env, info, 1, argv, &state) || !ParentFd(env, state, argv[0], &fd)) return nullptr;
  std::array<std::uint8_t, kMaxMetadata> payload{};
  alignas(cmsghdr) std::array<unsigned char,
      CMSG_SPACE(sizeof(int) * kMaxReceivedDescriptors)> control{};
  iovec iov{payload.data(), payload.size()};
  msghdr message{};
  message.msg_iov = &iov;
  message.msg_iovlen = 1;
  message.msg_control = control.data();
  message.msg_controllen = control.size();
  ssize_t size;
  do {
    size = ::recvmsg(fd, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  } while (size < 0 && errno == EINTR);
  if (size < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      napi_value result;
      if (!Check(env, napi_get_null(env, &result))) return nullptr;
      return result;
    }
    if (errno == ECONNRESET || errno == ENOTCONN)
      return Error(env, "ERR_FD_BRIDGE_CLOSED", "Channel peer closed or reset the connection");
    return SystemError(env, "recvmsg", errno);
  }

  std::array<int, kMaxReceivedDescriptors> received{};
  std::size_t count = 0;
  bool malformed = (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0;
  for (cmsghdr* header = CMSG_FIRSTHDR(&message); header;
       header = CMSG_NXTHDR(&message, header)) {
    const auto* start = reinterpret_cast<const unsigned char*>(header);
    const auto* end = control.data() + message.msg_controllen;
    if (header->cmsg_len < CMSG_LEN(0) || start + header->cmsg_len > end) {
      malformed = true;
      break;
    }
    if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) {
      malformed = true;
      continue;
    }
    const std::size_t bytes = header->cmsg_len - CMSG_LEN(0);
    if (bytes % sizeof(int) != 0) malformed = true;
    for (std::size_t offset = 0; offset + sizeof(int) <= bytes; offset += sizeof(int)) {
      int incoming;
      std::memcpy(&incoming, CMSG_DATA(header) + offset, sizeof(incoming));
      if (count < received.size()) received[count++] = incoming;
      else { ::close(incoming); malformed = true; }
    }
  }
  if (size == 0 || count != 1 || static_cast<std::size_t>(size) > payload.size()) malformed = true;
  if (malformed) {
    for (std::size_t i = 0; i < count; ++i) ::close(received[i]);
    if (size == 0 && count == 0)
      return Error(env, "ERR_FD_BRIDGE_CLOSED", "Channel closed or empty packet received");
    return Error(env, "ERR_FD_BRIDGE_PACKET", "Frame must have 1..4096 metadata bytes and exactly one FD, without truncation");
  }

  napi_value result, metadata, received_fd;
  if (!Check(env, napi_create_object(env, &result)) ||
      !Check(env, napi_create_buffer_copy(env, static_cast<std::size_t>(size), payload.data(), nullptr, &metadata)) ||
      !Check(env, napi_create_int32(env, received[0], &received_fd)) ||
      !Check(env, napi_set_named_property(env, result, "metadata", metadata)) ||
      !Check(env, napi_set_named_property(env, result, "fd", received_fd))) {
    ::close(received[0]);
    return nullptr;
  }
  state->owned.insert(received[0]);
  return result;
}

napi_value SendAck(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  State* state;
  int fd;
  std::uint64_t sequence;
  if (!Args(env, info, 2, argv, &state) || !ParentFd(env, state, argv[0], &fd) ||
      !GetSequence(env, argv[1], &sequence)) return nullptr;
  std::array<std::uint8_t, kAckBytes> packet{};
  EncodeAck(packet.data(), sequence);
  ssize_t size;
  do {
    size = ::send(fd, packet.data(), packet.size(), MSG_DONTWAIT | MSG_NOSIGNAL);
  } while (size < 0 && errno == EINTR);
  if (size < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) return Boolean(env, false);
    return SystemError(env, "send ack", errno);
  }
  if (size != static_cast<ssize_t>(packet.size()))
    return Error(env, "ERR_FD_BRIDGE_PACKET", "Unexpected partial SOCK_SEQPACKET ack write");
  return Boolean(env, true);
}

napi_value Close(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  State* state;
  int fd;
  if (!Args(env, info, 1, argv, &state) || !GetFd(env, argv[0], &fd)) return nullptr;
  if (!state->owned.count(fd)) return Boolean(env, false);
  CloseOwned(state, fd);
  return Boolean(env, true);
}

napi_value Init(napi_env env, napi_value exports) {
  auto* state = new (std::nothrow) State();
  if (!state) return Error(env, "ERR_FD_BRIDGE_MEMORY", "Cannot allocate bridge state");
  if (!Check(env, napi_add_env_cleanup_hook(env, Cleanup, state))) { delete state; return nullptr; }
  const napi_property_descriptor properties[] = {
    {"createChannel", nullptr, CreateChannel, nullptr, nullptr, nullptr, napi_default, state},
    {"receive", nullptr, Receive, nullptr, nullptr, nullptr, napi_default, state},
    {"sendAck", nullptr, SendAck, nullptr, nullptr, nullptr, napi_default, state},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, state},
  };
  if (!Check(env, napi_define_properties(env, exports, 4, properties))) return nullptr;
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
