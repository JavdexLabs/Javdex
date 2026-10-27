#pragma once
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>

namespace javdex {
constexpr int maximumFrameDimension = 8192;
constexpr size_t maximumFrameBytes = 256ULL * 1024 * 1024;
struct FrameLayout {
    int width = 1, height = 1;
    size_t stride = 64, bytes = 64;
};
inline FrameLayout frameLayout(double width, double height, double scale) {
    if (!std::isfinite(width) || !std::isfinite(height) || !std::isfinite(scale)
        || width <= 0 || height <= 0 || scale <= 0 || scale > 8)
        throw std::runtime_error("Invalid playback bounds");
    const double w = std::round(width * scale), h = std::round(height * scale);
    if (w < 1 || h < 1 || w > maximumFrameDimension || h > maximumFrameDimension) throw std::runtime_error("Playback viewport exceeds supported dimensions");
    FrameLayout result;
    result.width = static_cast<int>(w); result.height = static_cast<int>(h);
    result.stride = (static_cast<size_t>(result.width) * 4 + 63) & ~size_t(63);
    result.bytes = result.stride * result.height;
    if (result.bytes > maximumFrameBytes) throw std::runtime_error("Playback frame exceeds memory limit");
    return result;
}
struct RenderConfig {
    void *(*getProc)(void *, const char *) = nullptr;
    void *glContext = nullptr;
    void (*wakeup)(void *) = nullptr;
    void *wakeupContext = nullptr;
    // Borrowed render node; the Linux adapter owns it through renderer teardown.
    int drmRenderFd = -1;
    const char *hardwareDecode = "auto-copy";
    const char *renderLead = "0.02";
    bool cpu = false;
};
}
