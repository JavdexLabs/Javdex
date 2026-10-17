#pragma once
// Shape only the native child, so Chromium owns the existing accessible controls
// and popup input in the exposed areas. No top-level window or screenshot overlay.
#include <X11/Xutil.h>
#include <X11/extensions/shape.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace javdex::x11 {
struct Occlusion {
    double x, y, width, height;
    std::array<double, 4> radii{};
};
struct RegionDeleter { void operator()(Region region) const { if (region) XDestroyRegion(region); } };
using OwnedRegion = std::unique_ptr<std::remove_pointer_t<Region>, RegionDeleter>;
inline OwnedRegion region() {
    OwnedRegion value(XCreateRegion());
    if (!value) throw std::runtime_error("Cannot create X11 playback region");
    return value;
}
inline void addRectangle(Region region, int left, int top, int right, int bottom) {
    if (right <= left || bottom <= top) return;
    XRectangle rectangle{static_cast<short>(left), static_cast<short>(top),
        static_cast<unsigned short>(right - left), static_cast<unsigned short>(bottom - top)};
    XUnionRectWithRegion(&rectangle, region, region);
}
inline OwnedRegion surfaceRegion(int width, int height, int originX, int originY, double scale,
    const std::vector<Occlusion> &areas) {
    // Xlib Region coordinates are signed 16-bit, unlike an X window's size.
    if (width < 1 || height < 1 || width > 32767 || height > 32767 || !std::isfinite(scale) || scale <= 0 || scale > 8 || areas.size() > 32)
        throw std::runtime_error("Invalid X11 playback region bounds");
    auto visible = region();
    addRectangle(visible.get(), 0, 0, width, height);
    for (const auto &area : areas) {
        for (const double value : {area.x, area.y, area.width, area.height})
            if (!std::isfinite(value) || std::abs(value) > 100000) throw std::runtime_error("Invalid X11 playback popup bounds");
        if (area.width < 0 || area.height < 0) throw std::runtime_error("Invalid X11 playback popup size");
        std::array<double, 4> radii{};
        for (size_t i = 0; i < radii.size(); i++) {
            if (!std::isfinite(area.radii[i]) || area.radii[i] < 0 || area.radii[i] > 100000)
                throw std::runtime_error("Invalid X11 playback popup radius");
            radii[i] = std::min({area.radii[i], area.width / 2, area.height / 2}) * scale;
        }
        const double left = area.x * scale - originX, top = area.y * scale - originY;
        const double right = left + area.width * scale, bottom = top + area.height * scale;
        const int first = static_cast<int>(std::clamp(std::floor(top), 0.0, double(height)));
        const int end = static_cast<int>(std::clamp(std::ceil(bottom), 0.0, double(height)));
        auto cutout = region();
        int runLeft = 0, runRight = 0, runTop = first;
        const auto inset = [](double radius, double distance) {
            if (radius <= 0 || distance >= radius) return 0.0;
            return radius - std::sqrt(std::max(0.0, radius * radius - (radius - distance) * (radius - distance)));
        };
        for (int y = first; y < end; y++) {
            const double fromTop = y + 0.5 - top, fromBottom = bottom - y - 0.5;
            const int rowLeft = static_cast<int>(std::clamp(std::ceil(left + std::max(inset(radii[0], fromTop), inset(radii[3], fromBottom)) - 0.5), 0.0, double(width)));
            const int rowRight = static_cast<int>(std::clamp(std::ceil(right - std::max(inset(radii[1], fromTop), inset(radii[2], fromBottom)) - 0.5), 0.0, double(width)));
            if (y == first) { runLeft = rowLeft; runRight = rowRight; }
            if (rowLeft != runLeft || rowRight != runRight) {
                addRectangle(cutout.get(), runLeft, runTop, runRight, y);
                runTop = y; runLeft = rowLeft; runRight = rowRight;
            }
        }
        addRectangle(cutout.get(), runLeft, runTop, runRight, end);
        XSubtractRegion(visible.get(), cutout.get(), visible.get());
    }
    return visible;
}
inline void applySurfaceRegion(Display *display, Window window, Region region) {
    XShapeCombineRegion(display, window, ShapeBounding, 0, 0, region, ShapeSet);
    XShapeCombineRegion(display, window, ShapeInput, 0, 0, region, ShapeSet);
}
} // namespace javdex::x11
