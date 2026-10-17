#pragma once
// Private X11 handle/scaling helpers, independent of Display/GL/mpv.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>

namespace javdex::x11 {
inline bool softwareRenderer(const char *name) {
    const std::string renderer = name ? name : "";
    return renderer.find("llvmpipe") != std::string::npos || renderer.find("softpipe") != std::string::npos;
}
inline uint32_t windowId(const void *data, size_t length) {
    if (!data || length != sizeof(uint32_t)) throw std::runtime_error("Invalid Electron X11 Window buffer (expected uint32_t)");
    uint32_t id; std::memcpy(&id, data, sizeof(id));
    if (!id) throw std::runtime_error("Missing X11 parent");
    return id;
}
inline int pixel(double value, double scale, int minimum = -32768, int maximum = 32767) {
    if (!std::isfinite(value) || !std::isfinite(scale) || scale <= 0) return minimum;
    return static_cast<int>(std::lround(std::clamp(value * scale, static_cast<double>(minimum), static_cast<double>(maximum))));
}
} // namespace javdex::x11
