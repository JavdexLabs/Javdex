#ifndef __linux__
#error "The private FD bridge is Linux-only."
#endif

#include <node_api.h>
#include <uv.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <new>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "linuxFdTransport.h"

namespace {
using namespace javdex_transport;

struct Watch;
struct ReadJob;
struct State {
  std::set<int> owned;
  std::set<int> parents;
  std::map<int, Watch*> watchers;
  std::set<Watch*> allocated;
  std::map<int, ReadJob*> reads;
  bool shutting_down = false;
  bool in_cleanup = false;
};
// A started libuv worker cannot be cancelled. The job owns the descriptor
// until its complete callback runs, including after session teardown.
struct ReadJob {
  State* state = nullptr;
  napi_env env = nullptr;
  int fd = -1;
  size_t length = 0;
  void* pixels = nullptr;
  napi_ref buffer = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool close_after = false;
  int error = 0;
};
constexpr int kMaxCpuReads = 3;
struct Watch {
  uv_poll_t poll{};
  State* owner = nullptr;
  napi_env env = nullptr;
  napi_ref callback = nullptr;
  napi_async_context context = nullptr;
  bool closing = false;
};

void ReleaseWatchReferences(Watch* watch) {
  if (watch->callback) { napi_delete_reference(watch->env, watch->callback); watch->callback = nullptr; }
  if (watch->context) { napi_async_destroy(watch->env, watch->context); watch->context = nullptr; }
}
void CloseWatch(Watch* watch) {
  if (watch->closing) return;
  watch->closing = true;
  uv_poll_stop(&watch->poll);
  uv_close(reinterpret_cast<uv_handle_t*>(&watch->poll), [](uv_handle_t* handle) {
    auto* watch = static_cast<Watch*>(handle->data);
    ReleaseWatchReferences(watch);
    if (watch->owner) watch->owner->allocated.erase(watch);
    delete watch;
  });
}
void StopWatch(State* state, int fd) {
  const auto found = state->watchers.find(fd);
  if (found == state->watchers.end()) return;
  auto* watch = found->second;
  state->watchers.erase(found);
  CloseWatch(watch);
}

// On Linux, never retry close(2) after EINTR: the descriptor may already have
// been released and reused. Ownership leaves the addon before close is called.
void CloseOwned(State* state, int fd) {
  // libuv never owns the descriptor. Stop before close/reuse, including when
  // JS forgets to unwatch or closes a channel from inside its own callback.
  StopWatch(state, fd);
  if (const auto found = state->reads.find(fd); found != state->reads.end()) {
    found->second->close_after = true;
    return;
  }
  state->parents.erase(fd);
  state->owned.erase(fd);
  ::close(fd);
}

void FinishRead(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<ReadJob*>(data);
  auto* state = job->state;
  if (state) state->reads.erase(job->fd);
  if (state && (job->close_after || state->shutting_down) && state->owned.erase(job->fd)) {
    state->parents.erase(job->fd);
    ::close(job->fd);
  }
  if (state && !state->shutting_down) {
    napi_value result = nullptr;
    if (status != napi_ok || job->error) {
      napi_value message = nullptr, code = nullptr;
      napi_create_string_utf8(env, job->error ? "Cannot read CPU frame" : "CPU frame read cancelled", NAPI_AUTO_LENGTH, &message);
      napi_create_string_utf8(env, "ERR_CPU_FRAME", NAPI_AUTO_LENGTH, &code);
      napi_create_error(env, code, message, &result);
      napi_reject_deferred(env, job->deferred, result);
    } else {
      napi_get_reference_value(env, job->buffer, &result);
      napi_resolve_deferred(env, job->deferred, result);
    }
    if (job->buffer) napi_delete_reference(env, job->buffer);
    if (job->work) napi_delete_async_work(env, job->work);
  }
  const bool retire = state && state->shutting_down && !state->in_cleanup && state->reads.empty();
  delete job;
  if (retire) delete state;
}

void ExecuteRead(napi_env, void* data) {
  auto* job = static_cast<ReadJob*>(data);
  size_t offset = 0;
  while (offset < job->length) {
    const auto read = ::pread(job->fd, static_cast<char*>(job->pixels) + offset, job->length - offset, static_cast<off_t>(offset));
    if (read < 0 && errno == EINTR) continue;
    if (read <= 0) { job->error = errno ? errno : EIO; return; }
    offset += static_cast<size_t>(read);
  }
}

void Cleanup(void* data) {
  auto* state = static_cast<State*>(data);
  state->shutting_down = true;
  state->in_cleanup = true;
  state->watchers.clear();
  while (!state->allocated.empty()) {
    auto* watch = *state->allocated.begin(); state->allocated.erase(state->allocated.begin());
    watch->owner = nullptr;
    CloseWatch(watch);
    // This includes already-closing handles: their uv_close callback may run
    // after the N-API environment is gone, and must then only delete memory.
    ReleaseWatchReferences(watch); watch->env = nullptr;
  }
  std::vector<int> idle;
  for (int fd : state->owned) if (!state->reads.count(fd)) idle.push_back(fd);
  for (int fd : idle) { state->owned.erase(fd); ::close(fd); }
  std::vector<ReadJob*> jobs;
  for (const auto& entry : state->reads) jobs.push_back(entry.second);
  for (auto* job : jobs) napi_cancel_async_work(job->env, job->work);
  state->in_cleanup = false;
  if (state->reads.empty()) delete state;
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

bool GetEvents(napi_env env, napi_value value, int* events) {
  double number = -1; napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number
      || napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number)
      || std::floor(number) != number || number < 0 || number > (UV_READABLE | UV_WRITABLE)) {
    napi_throw_type_error(env, "ERR_FD_BRIDGE_WATCH", "events must be a readable/writable bit mask (0..3)");
    return false;
  }
  *events = static_cast<int>(number); return true;
}
void PollReady(uv_poll_t* handle, int status, int events) {
  auto* watch = static_cast<Watch*>(handle->data);
  if (watch->closing || !watch->env) return;
  const auto env = watch->env;
  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  napi_value callback, receiver, args[2], result;
  if (napi_get_reference_value(env, watch->callback, &callback) == napi_ok
      && napi_get_global(env, &receiver) == napi_ok
      && napi_create_int32(env, status, &args[0]) == napi_ok
      && napi_create_int32(env, events, &args[1]) == napi_ok) {
    // JS can stop/close/reuse the FD in this call. Watch memory/context is
    // retained until uv_close, after this callback has returned.
    if (napi_make_callback(env, watch->context, receiver, callback, 2, args, &result) == napi_pending_exception) {
      napi_value error; napi_get_and_clear_last_exception(env, &error); napi_fatal_exception(env, error);
    }
  }
  napi_close_handle_scope(env, scope);
}
int SetWatchEvents(Watch* watch, int events) {
  return events ? uv_poll_start(&watch->poll, events, PollReady) : uv_poll_stop(&watch->poll);
}
napi_value WatchChannel(napi_env env, napi_callback_info info) {
  napi_value args[3]; State* state; int fd, events; napi_valuetype type;
  if (!Args(env, info, 3, args, &state) || !ParentFd(env, state, args[0], &fd) || !GetEvents(env, args[1], &events)) return nullptr;
  if (!Check(env, napi_typeof(env, args[2], &type))) return nullptr;
  if (type != napi_function) { napi_throw_type_error(env, "ERR_FD_BRIDGE_WATCH", "callback must be a function"); return nullptr; }
  if (state->watchers.count(fd)) return Error(env, "ERR_FD_BRIDGE_WATCH", "A channel can have only one readiness watcher");
  auto* watch = new (std::nothrow) Watch();
  if (!watch) return Error(env, "ERR_FD_BRIDGE_MEMORY", "Cannot allocate readiness watcher");
  watch->env = env; watch->owner = state;
  uv_loop_t* loop = nullptr; napi_value resource, name;
  if (!Check(env, napi_get_uv_event_loop(env, &loop))
      || !Check(env, napi_create_reference(env, args[2], 1, &watch->callback))
      || !Check(env, napi_create_object(env, &resource))
      || !Check(env, napi_create_string_utf8(env, "JavdexFDReadiness", NAPI_AUTO_LENGTH, &name))
      || !Check(env, napi_async_init(env, resource, name, &watch->context))) {
    ReleaseWatchReferences(watch); delete watch; return nullptr;
  }
  const int initialized = uv_poll_init(loop, &watch->poll, fd);
  if (initialized < 0) {
    ReleaseWatchReferences(watch); delete watch;
    return Error(env, "ERR_FD_BRIDGE_WATCH", uv_strerror(initialized));
  }
  watch->poll.data = watch;
  state->allocated.insert(watch); state->watchers.emplace(fd, watch);
  uv_unref(reinterpret_cast<uv_handle_t*>(&watch->poll));
  const int started = SetWatchEvents(watch, events);
  if (started < 0) { StopWatch(state, fd); return Error(env, "ERR_FD_BRIDGE_WATCH", uv_strerror(started)); }
  return Boolean(env, true);
}
napi_value UpdateWatch(napi_env env, napi_callback_info info) {
  napi_value args[2]; State* state; int fd, events;
  if (!Args(env, info, 2, args, &state) || !ParentFd(env, state, args[0], &fd) || !GetEvents(env, args[1], &events)) return nullptr;
  const auto found = state->watchers.find(fd);
  if (found == state->watchers.end()) return Error(env, "ERR_FD_BRIDGE_WATCH", "Channel has no readiness watcher");
  const int result = SetWatchEvents(found->second, events);
  return result < 0 ? Error(env, "ERR_FD_BRIDGE_WATCH", uv_strerror(result)) : Boolean(env, true);
}
napi_value Unwatch(napi_env env, napi_callback_info info) {
  napi_value args[1]; State* state; int fd;
  if (!Args(env, info, 1, args, &state) || !GetFd(env, args[0], &fd)) return nullptr;
  const bool present = state->watchers.count(fd) != 0;
  StopWatch(state, fd); return Boolean(env, present);
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

// Copy only an addon-owned, fixed-size sealed memfd. Renderer never supplies FDs.
bool ValidateCpuFrame(napi_env env, State* state, int fd, double length, size_t* bytes) {
  if (!std::isfinite(length) || length < 4 || length > 256 * 1024 * 1024 || std::floor(length) != length
      || !state->owned.count(fd) || state->parents.count(fd) || state->reads.count(fd))
    return Error(env, "ERR_CPU_FRAME", "Invalid CPU frame ownership or size"), false;
  struct stat status{};
  const int seals = fcntl(fd, F_GET_SEALS);
  if (fstat(fd, &status) != 0 || !S_ISREG(status.st_mode) || status.st_size != static_cast<off_t>(length)
      || seals < 0 || (seals & (F_SEAL_SHRINK | F_SEAL_GROW)) != (F_SEAL_SHRINK | F_SEAL_GROW))
    return Error(env, "ERR_CPU_FRAME", "CPU frame must have a sealed fixed size"), false;
  *bytes = static_cast<size_t>(length);
  return true;
}

napi_value ReadPixels(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2; void* data = nullptr;
  napi_get_cb_info(env, info, &count, args, nullptr, &data);
  auto* state = static_cast<State*>(data);
  int32_t fd = -1; double length = 0; size_t bytes = 0;
  if (count != 2 || napi_get_value_int32(env, args[0], &fd) != napi_ok
      || napi_get_value_double(env, args[1], &length) != napi_ok
      || !ValidateCpuFrame(env, state, fd, length, &bytes)) return nullptr;
  void* pixels = nullptr; napi_value result;
  if (napi_create_buffer(env, bytes, &pixels, &result) != napi_ok) return nullptr;
  size_t offset = 0;
  while (offset < bytes) {
    const auto read = pread(fd, static_cast<char*>(pixels) + offset, bytes - offset, static_cast<off_t>(offset));
    if (read < 0 && errno == EINTR) continue;
    if (read <= 0) return Error(env, "ERR_CPU_FRAME", "Cannot read CPU frame");
    offset += static_cast<size_t>(read);
  }
  return result;
}

napi_value ReadPixelsAsync(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2; void* data = nullptr;
  napi_get_cb_info(env, info, &count, args, nullptr, &data);
  auto* state = static_cast<State*>(data);
  if (state->reads.size() >= static_cast<size_t>(kMaxCpuReads))
    return Error(env, "ERR_CPU_FRAME", "CPU frame read budget exhausted");
  int32_t fd = -1; double length = 0; size_t bytes = 0;
  if (count != 2 || napi_get_value_int32(env, args[0], &fd) != napi_ok
      || napi_get_value_double(env, args[1], &length) != napi_ok
      || !ValidateCpuFrame(env, state, fd, length, &bytes)) return nullptr;
  auto* job = new (std::nothrow) ReadJob();
  if (!job) return Error(env, "ERR_FD_BRIDGE_MEMORY", "Cannot allocate CPU frame read");
  job->state = state; job->env = env; job->fd = fd; job->length = bytes;
  napi_value buffer = nullptr, promise = nullptr, name = nullptr;
  if (napi_create_buffer(env, bytes, &job->pixels, &buffer) != napi_ok
      || napi_create_reference(env, buffer, 1, &job->buffer) != napi_ok
      || napi_create_promise(env, &job->deferred, &promise) != napi_ok
      || napi_create_string_utf8(env, "javdex:cpu-frame-read", NAPI_AUTO_LENGTH, &name) != napi_ok
      || napi_create_async_work(env, nullptr, name, ExecuteRead, FinishRead, job, &job->work) != napi_ok
      || napi_queue_async_work(env, job->work) != napi_ok) {
    if (job->work) napi_delete_async_work(env, job->work);
    if (job->buffer) napi_delete_reference(env, job->buffer);
    if (promise) {
      napi_value message = nullptr, code = nullptr, error_value = nullptr;
      napi_create_string_utf8(env, "Cannot start CPU frame read", NAPI_AUTO_LENGTH, &message);
      napi_create_string_utf8(env, "ERR_CPU_FRAME", NAPI_AUTO_LENGTH, &code);
      napi_create_error(env, code, message, &error_value);
      napi_reject_deferred(env, job->deferred, error_value);
      delete job;
      return promise;
    }
    delete job;
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) return nullptr;
    return Error(env, "ERR_CPU_FRAME", "Cannot start CPU frame read");
  }
  state->reads.emplace(fd, job);
  return promise;
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
    {"readPixels", nullptr, ReadPixels, nullptr, nullptr, nullptr, napi_default, state},
    {"readPixelsAsync", nullptr, ReadPixelsAsync, nullptr, nullptr, nullptr, napi_default, state},
    {"watch", nullptr, WatchChannel, nullptr, nullptr, nullptr, napi_default, state},
    {"updateWatch", nullptr, UpdateWatch, nullptr, nullptr, nullptr, napi_default, state},
    {"unwatch", nullptr, Unwatch, nullptr, nullptr, nullptr, napi_default, state},
  };
  if (!Check(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties))) return nullptr;
  return exports;
}
}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
