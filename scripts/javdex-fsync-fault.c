#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_FD 8192

static int (*real_fsync)(int);
static int (*real_fdatasync)(int);
static int (*real_open)(const char *, int, ...);
static int (*real_open64)(const char *, int, ...);
static int (*real_openat)(int, const char *, int, ...);
static int (*real_openat64)(int, const char *, int, ...);
static int (*real_dup)(int);
static int (*real_dup2)(int, int);
static int (*real_dup3)(int, int, int);
static int (*real_close)(int);
static unsigned char tracked[MAX_FD];
static int ready;

static void bind_reals(void) {
  if (ready) return;
  real_fsync = dlsym(RTLD_NEXT, "fsync");
  real_fdatasync = dlsym(RTLD_NEXT, "fdatasync");
  real_open = dlsym(RTLD_NEXT, "open");
  real_open64 = dlsym(RTLD_NEXT, "open64");
  real_openat = dlsym(RTLD_NEXT, "openat");
  real_openat64 = dlsym(RTLD_NEXT, "openat64");
  real_dup = dlsym(RTLD_NEXT, "dup");
  real_dup2 = dlsym(RTLD_NEXT, "dup2");
  real_dup3 = dlsym(RTLD_NEXT, "dup3");
  real_close = dlsym(RTLD_NEXT, "close");
  ready = 1;
}

static int fault_enabled(void) {
  const char *path = getenv("JAVDEX_TEST_FSYNC_FAULT");
  return path && path[0] && access(path, F_OK) == 0;
}

static int is_catalog(const char *path) {
  return path && strstr(path, "library.db") != NULL;
}

static void track_path(int fd, const char *path) {
  if (fd < 0 || fd >= MAX_FD) return;
  tracked[fd] = is_catalog(path) ? 1 : 0;
}

static void track_dup(int from, int to) {
  if (to < 0 || to >= MAX_FD) return;
  tracked[to] = (from >= 0 && from < MAX_FD) ? tracked[from] : 0;
}

static int maybe_fault(int fd) {
  if (fd >= 0 && fd < MAX_FD && tracked[fd] && fault_enabled()) {
    fprintf(stderr, "JAVDEX_FSYNC_FAULT fd=%d\n", fd);
    fflush(stderr);
    errno = EIO;
    return -1;
  }
  return 0;
}

int fsync(int fd) {
  bind_reals();
  if (maybe_fault(fd)) return -1;
  return real_fsync(fd);
}

int fdatasync(int fd) {
  bind_reals();
  if (maybe_fault(fd)) return -1;
  return real_fdatasync(fd);
}

int open(const char *path, int flags, ...) {
  va_list args;
  mode_t mode = 0;
  int fd;
  bind_reals();
  va_start(args, flags);
  if (flags & O_CREAT) mode = (mode_t)va_arg(args, int);
  va_end(args);
  fd = real_open(path, flags, mode);
  track_path(fd, path);
  return fd;
}

int open64(const char *path, int flags, ...) {
  va_list args;
  mode_t mode = 0;
  int fd;
  bind_reals();
  if (!real_open64) return open(path, flags);
  va_start(args, flags);
  if (flags & O_CREAT) mode = (mode_t)va_arg(args, int);
  va_end(args);
  fd = real_open64(path, flags, mode);
  track_path(fd, path);
  return fd;
}

int openat(int dirfd, const char *path, int flags, ...) {
  va_list args;
  mode_t mode = 0;
  int fd;
  bind_reals();
  va_start(args, flags);
  if (flags & O_CREAT) mode = (mode_t)va_arg(args, int);
  va_end(args);
  fd = real_openat(dirfd, path, flags, mode);
  track_path(fd, path);
  return fd;
}

int openat64(int dirfd, const char *path, int flags, ...) {
  va_list args;
  mode_t mode = 0;
  int fd;
  bind_reals();
  if (!real_openat64) return openat(dirfd, path, flags);
  va_start(args, flags);
  if (flags & O_CREAT) mode = (mode_t)va_arg(args, int);
  va_end(args);
  fd = real_openat64(dirfd, path, flags, mode);
  track_path(fd, path);
  return fd;
}

int dup(int fd) {
  int next;
  bind_reals();
  next = real_dup(fd);
  track_dup(fd, next);
  return next;
}

int dup2(int fd, int fd2) {
  int next;
  bind_reals();
  next = real_dup2(fd, fd2);
  track_dup(fd, next);
  return next;
}

int dup3(int fd, int fd2, int flags) {
  int next;
  bind_reals();
  if (!real_dup3) return dup2(fd, fd2);
  next = real_dup3(fd, fd2, flags);
  track_dup(fd, next);
  return next;
}

int close(int fd) {
  bind_reals();
  if (fd >= 0 && fd < MAX_FD) tracked[fd] = 0;
  return real_close(fd);
}
