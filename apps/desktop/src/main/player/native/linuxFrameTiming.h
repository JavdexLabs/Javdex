#pragma once
#include <cstdint>
#include <stdexcept>
#include <string>
#ifdef __linux__
#include <time.h>
#endif

namespace javdex {
// Metadata only: never calls report_swap and owns no frame or release fence.
// libmpv supplies a delta from its clock; both Linux producers anchor it in
// CLOCK_MONOTONIC. Zero means an immediate paused/redraw frame, not "now".
struct LinuxFrameTiming {
    uint64_t timeline = 0;
    int64_t renderStartUs = 0, targetTimeUs = 0;
    void reset(uint64_t next) {
        if (next <= timeline || next > 9007199254740991ULL) throw std::runtime_error("Invalid timing epoch");
        timeline = next; renderStartUs = targetTimeUs = 0;
    }
    void sample(int64_t start, int64_t delay) {
        if (start <= 0 || delay < -start || delay > 9007199254740991LL - start)
            throw std::runtime_error("Invalid frame clock");
        renderStartUs = start; targetTimeUs = delay ? start + delay : 0;
    }
    std::string metadata() const {
        return ",\"timeline\":" + std::to_string(timeline) + ",\"targetTimeUs\":" + std::to_string(targetTimeUs)
            + ",\"renderStartUs\":" + std::to_string(renderStartUs);
    }
};
#ifdef __linux__
inline int64_t linuxFrameClockUs() {
    timespec ts{};
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) throw std::runtime_error("Cannot read frame clock");
    return int64_t(ts.tv_sec) * 1000000 + ts.tv_nsec / 1000;
}
#endif
}
