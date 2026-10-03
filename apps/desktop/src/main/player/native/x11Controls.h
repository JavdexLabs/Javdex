#pragma once
// Private X11 geometry/input model, independent of Display/GL/mpv. The adapter
// submits these actions through the existing session, never directly to mpv.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>

namespace javdex::x11 {
inline uint32_t windowId(const void *data, size_t length) {
    if (!data || length != sizeof(uint32_t)) throw std::runtime_error("Invalid Electron X11 Window buffer (expected uint32_t)");
    uint32_t id; std::memcpy(&id, data, sizeof(id));
    if (!id) throw std::runtime_error("Missing X11 parent");
    return id;
}
enum class Control { Video, Seek, Pause, Volume, Dock, Fullscreen, Stop, Empty };
struct Rect {
    int x, y, width, height;
    bool contains(int px, int py) const { return px >= x && py >= y && px < x + width && py < y + height; }
};
inline int pixel(double value, double scale, int minimum = -32768, int maximum = 32767) {
    if (!std::isfinite(value) || !std::isfinite(scale) || scale <= 0) return minimum;
    return static_cast<int>(std::lround(std::clamp(value * scale, static_cast<double>(minimum), static_cast<double>(maximum))));
}
inline double fraction(const Rect &rect, int x) {
    return std::clamp(static_cast<double>(x - rect.x) / std::max(1, rect.width - 1), 0.0, 1.0);
}
struct Controls {
    Rect bounds{};
    Rect seek{}, pause{}, volume{}, dock{}, fullscreen{}, stop{};
    Control focus = Control::Video;
    void layout(int width, double scale) {
        auto rect = [scale](double x, double y, double w, double h) {
            return Rect{pixel(x, scale), pixel(y, scale), pixel(w, scale, 1, 65535), pixel(h, scale, 1, 65535)};
        };
        bounds = {0, 0, width, pixel(76, scale, 1, 65535)};
        seek = rect(8, 4, std::max(1.0, width / scale - 16), 24);
        pause = rect(8, 36, 88, 32); dock = rect(104, 36, 64, 32);
        fullscreen = rect(176, 36, 96, 32); stop = rect(280, 36, 64, 32);
        volume = rect(360, 36, 120, 32);
    }
    const Rect &rect(Control control) const {
        switch (control) {
            case Control::Seek: return seek; case Control::Pause: return pause;
            case Control::Volume: return volume; case Control::Dock: return dock;
            case Control::Fullscreen: return fullscreen; default: return stop;
        }
    }
    Control hit(int x, int y) const {
        for (auto control : {Control::Seek, Control::Pause, Control::Volume, Control::Dock, Control::Fullscreen, Control::Stop})
            if (rect(control).contains(x, y)) return control;
        return Control::Empty;
    }
    Control tab(bool backwards, bool seekable) {
        constexpr std::array order{Control::Video, Control::Seek, Control::Pause, Control::Volume, Control::Dock, Control::Fullscreen, Control::Stop};
        auto found = std::find(order.begin(), order.end(), focus);
        const int index = found == order.end() ? 0 : static_cast<int>(found - order.begin());
        for (int step = 1; step <= static_cast<int>(order.size()); step++) {
            const int next = (index + (backwards ? -step : step) + static_cast<int>(order.size())) % static_cast<int>(order.size());
            if (order[next] != Control::Seek || seekable) { focus = order[next]; break; }
        }
        return focus;
    }
    const char *activation() const {
        switch (focus) {
            case Control::Pause: return "toggle-pause"; case Control::Dock: return "dock";
            case Control::Fullscreen: return "fullscreen"; case Control::Stop: return "stop";
            default: return nullptr;
        }
    }
};
} // namespace javdex::x11
