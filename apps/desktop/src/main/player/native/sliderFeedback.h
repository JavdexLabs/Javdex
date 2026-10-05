#pragma once
#include <cmath>
#include <cstdint>
#include <optional>
#include <algorithm>

namespace javdex {
inline int sliderPositionAt(double x, double start, double end, int minimum, int maximum) {
    if (end <= start || maximum <= minimum) return minimum;
    const double fraction = std::clamp((x - start) / (end - start), 0.0, 1.0);
    return minimum + static_cast<int>(std::lround(fraction * (maximum - minimum)));
}

// A submitted trackbar value must survive cached observations until the core
// acknowledges it. This is display feedback only, never a playback command.
class SliderFeedback {
    std::optional<double> pending;
    uint64_t requestedAt = 0;
    double tolerance;
    uint64_t timeout;
public:
    explicit SliderFeedback(double tolerance, uint64_t timeout) : tolerance(tolerance), timeout(timeout) {}
    void request(double value, uint64_t now) { pending = value; requestedAt = now; }
    double value(double observed, bool busy, uint64_t now) {
        if (pending && ((!busy && std::abs(observed - *pending) <= tolerance) || now - requestedAt >= timeout)) pending.reset();
        return pending.value_or(observed);
    }
    void reset() { pending.reset(); }
};
}
