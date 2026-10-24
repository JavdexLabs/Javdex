#include "macSurfaceTransport.h"
#include <cassert>
#include <cstdio>
#include <random>
#include <sys/wait.h>
#include <unistd.h>
#ifdef NDEBUG
#error Native preflight requires assertions enabled
#endif
int main(int argc, char **argv) {
    alarm(15); // A failed transfer/lock must stop the build instead of hanging it.
    using namespace javdex::mac;
    if (argc == 2) {
        const auto surface = createSurface(32, 16);
        assert(IOSurfaceLock(surface, 0, nullptr) == kIOReturnSuccess);
        auto pixels = static_cast<unsigned char *>(IOSurfaceGetBaseAddress(surface));
        for (int y = 0; y < 16; y++) for (int x = 0; x < 32; x++) {
            auto p = pixels + y * IOSurfaceGetBytesPerRow(surface) + x * 4;
            p[0] = 128; p[1] = 191; p[2] = 64; p[3] = 255;
        }
        assert(IOSurfaceUnlock(surface, 0, nullptr) == kIOReturnSuccess);
        SurfaceChannels::publish(argv[1], 1, surface); CFRelease(surface); return 0;
    }
    std::random_device random;
    const std::string name = "org.javdex.playback.preflight." + std::to_string(getpid()) + "." + std::to_string(random());
    SurfaceChannels channels; channels.open(name);
    const pid_t child = fork(); assert(child >= 0);
    if (!child) { execl(argv[0], argv[0], name.c_str(), nullptr); _exit(127); }
    int status = 0; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    // Receive only after the producer has exited: the transferred Mach right
    // must retain the allocation independently of its producer process.
    const auto surface = channels.acquire(name, 1);
    assert(IOSurfaceGetWidth(surface) == 32 && IOSurfaceGetHeight(surface) == 16);
    assert(IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) == kIOReturnSuccess);
    const auto pixels = static_cast<const unsigned char *>(IOSurfaceGetBaseAddress(surface));
    for (int y = 0; y < 16; y++) for (int x = 0; x < 32; x++) {
        const auto p = pixels + y * IOSurfaceGetBytesPerRow(surface) + x * 4;
        assert(p[0] == 128 && p[1] == 191 && p[2] == 64 && p[3] == 255);
    }
    assert(IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr) == kIOReturnSuccess);
    CFRelease(surface); channels.close(name);
    std::puts("IOSurface cross-process retain/release preflight passed (CPU memory; no CGL/Chromium acceptance)");
}
