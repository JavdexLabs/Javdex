#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__aarch64__)
#define JAVDEX_GLIBC_VERSION "GLIBC_2.17"
#else
#define JAVDEX_GLIBC_VERSION "GLIBC_2.2.5"
#endif

static int (*real_fsync)(int);
static int (*real_fdatasync)(int);
static ssize_t (*real_write)(int, const void *, size_t);
static ssize_t (*real_pwrite64)(int, const void *, size_t, off_t);
static int ready;

__attribute__((constructor)) static void onload(void) {
  fprintf(stderr, "JAVDEX_FSYNC_PRELOAD_LOADED\n");
  fflush(stderr);
}

static void bind_reals(void) {
  if (ready) return;
  real_fsync = dlvsym(RTLD_NEXT, "fsync", JAVDEX_GLIBC_VERSION);
  if (!real_fsync) real_fsync = dlsym(RTLD_NEXT, "fsync");
  real_fdatasync = dlsym(RTLD_NEXT, "fdatasync");
  real_write = dlvsym(RTLD_NEXT, "write", JAVDEX_GLIBC_VERSION);
  if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
  real_pwrite64 = dlvsym(RTLD_NEXT, "pwrite64", JAVDEX_GLIBC_VERSION);
  if (!real_pwrite64) real_pwrite64 = dlsym(RTLD_NEXT, "pwrite64");
  ready = 1;
}

static int fault_enabled(void) {
  const char *path = getenv("JAVDEX_TEST_FSYNC_FAULT");
  return path && path[0] && access(path, F_OK) == 0;
}

static int fd_is_catalog(int fd) {
  char link[64];
  char target[512];
  ssize_t n;
  if (fd < 0) return 0;
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  n = readlink(link, target, sizeof(target) - 1);
  if (n < 0) return 0;
  target[n] = '\0';
  return strstr(target, "library.db") != NULL;
}

static int maybe_fault(int fd, const char *op) {
  if (!fault_enabled() || !fd_is_catalog(fd)) return 0;
  fprintf(stderr, "JAVDEX_FSYNC_FAULT op=%s fd=%d\n", op, fd);
  fflush(stderr);
  errno = EIO;
  return -1;
}

int fsync(int fd) {
  bind_reals();
  if (maybe_fault(fd, "fsync")) return -1;
  return real_fsync(fd);
}

int fdatasync(int fd) {
  bind_reals();
  if (maybe_fault(fd, "fdatasync")) return -1;
  return real_fdatasync ? real_fdatasync(fd) : real_fsync(fd);
}

ssize_t write(int fd, const void *buf, size_t count) {
  bind_reals();
  if (maybe_fault(fd, "write")) return -1;
  return real_write(fd, buf, count);
}

ssize_t pwrite64(int fd, const void *buf, size_t count, off_t offset) {
  bind_reals();
  if (maybe_fault(fd, "pwrite64")) return -1;
  return real_pwrite64(fd, buf, count, offset);
}

__asm__(".symver fsync,fsync@" JAVDEX_GLIBC_VERSION);
__asm__(".symver write,write@" JAVDEX_GLIBC_VERSION);
__asm__(".symver pwrite64,pwrite64@" JAVDEX_GLIBC_VERSION);

__asm__(".symver fdatasync,fdatasync@" JAVDEX_GLIBC_VERSION);
