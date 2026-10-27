#pragma once
#include <algorithm>
#include <cstdint>
#include <initializer_list>
#include <iomanip>
#include <locale>
#include <sstream>
#include <string>
#include <utility>

namespace javdex {
// Bounded cumulative wall samples, not GPU timestamps or physical scanout.
// Keep counts/totals so a controller can exclude warmup by taking differences.
struct LinuxStageTiming {
    uint64_t samples = 0;
    double totalMs = 0, maxMs = 0, lastMs = 0;
    void record(int64_t us) {
        if (us < 0) return;
        lastMs = double(us) / 1000;
        ++samples; totalMs += lastMs; maxMs = std::max(maxMs, lastMs);
    }
    std::string json() const {
        if (!samples) return "null";
        std::ostringstream out; out.imbue(std::locale::classic());
        out << std::setprecision(12);
        out << "{\"samples\":" << samples << ",\"totalMs\":" << totalMs
            << ",\"meanMs\":" << totalMs / samples << ",\"maxMs\":" << maxMs
            << ",\"lastMs\":" << lastMs << '}';
        return out.str();
    }
};
inline std::string linuxTimingsJson(std::initializer_list<std::pair<const char *, const LinuxStageTiming *>> stages) {
    std::string out = "{";
    for (const auto &stage : stages) {
        if (!stage.second->samples) continue; // Missing samples are not zero cost.
        if (out.size() > 1) out += ',';
        out += '"' + std::string(stage.first) + "\":" + stage.second->json();
    }
    return out + '}';
}
}
