#pragma once
// SDR Canvas output: BT.709 primaries, sRGB transfer, full range, 203 nit
// reference white. The software path applies this before libass/OSD, using a
// tetrahedral 3D LUT; no display, GL context or hardware decoder is required.
// ST 2084 / BT.2100 / BT.2390 equations match the pinned mpv vo_gpu policy.
#include <algorithm>
#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <locale>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

namespace javdex::color {
using RGB = std::array<double, 3>;
using Matrix = std::array<RGB, 3>;
inline RGB multiply(const Matrix &m, RGB v) {
    RGB result{};
    for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) result[i] += m[i][j] * v[j];
    return result;
}
inline Matrix inverse(const Matrix &m) {
    const double d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    Matrix r;
    for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++)
        r[i][j] = (m[(j + 1) % 3][(i + 1) % 3] * m[(j + 2) % 3][(i + 2) % 3]
            - m[(j + 1) % 3][(i + 2) % 3] * m[(j + 2) % 3][(i + 1) % 3]) / d;
    return r;
}
inline RGB white(const std::string &primaries) {
    double x = .3127, y = .3290;
    if (primaries == "bt.470m" || primaries == "film-c") { x = .31006; y = .31616; }
    if (primaries == "prophoto") { x = .34567; y = .35850; }
    if (primaries == "cie1931") { x = y = 1.0 / 3; }
    if (primaries == "dci-p3") { x = .314; y = .351; }
    return {x / y, 1, (1 - x - y) / y};
}
inline Matrix rgbToXyz(const std::string &primaries) {
    // Chromaticities from the named standards. D65 is also used by mpv for
    // inferred HD/SD video. Keep full precision for reference comparisons.
    RGB x{.64, .30, .15}, y{.33, .60, .06};
    if (primaries == "bt.2020") { x = {.708, .170, .131}; y = {.292, .797, .046}; }
    if (primaries == "bt.601-525" || primaries == "smpte-240m") { x = {.630, .310, .155}; y = {.340, .595, .070}; }
    if (primaries == "bt.601-625") { x = {.640, .290, .150}; y = {.330, .600, .060}; }
    if (primaries == "display-p3" || primaries == "dci-p3") { x = {.680, .265, .150}; y = {.320, .690, .060}; }
    if (primaries == "adobe") { x = {.640, .210, .150}; y = {.330, .710, .060}; }
    if (primaries == "bt.470m") { x = {.670, .210, .140}; y = {.330, .710, .080}; }
    if (primaries == "apple") { x = {.625, .280, .115}; y = {.340, .595, .070}; }
    if (primaries == "prophoto") { x = {.7347, .1596, .0366}; y = {.2653, .8404, .0001}; }
    if (primaries == "cie1931") { x = {.7347, .2738, .1666}; y = {.2653, .7174, .0089}; }
    if (primaries == "v-gamut") { x = {.730, .165, .100}; y = {.280, .840, -.03}; }
    if (primaries == "s-gamut") { x = {.730, .140, .100}; y = {.280, .855, -.05}; }
    if (primaries == "film-c") { x = {.681, .243, .145}; y = {.319, .692, .049}; }
    if (primaries == "ebu3213") { x = {.630, .295, .155}; y = {.340, .605, .077}; }
    Matrix matrix;
    for (int i = 0; i < 3; i++) { matrix[0][i] = x[i] / y[i]; matrix[1][i] = 1; matrix[2][i] = (1 - x[i] - y[i]) / y[i]; }
    const auto scale = multiply(inverse(matrix), white(primaries));
    for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) matrix[i][j] *= scale[j];
    return matrix;
}
struct Profile {
    std::string transfer = "bt.1886", primaries = "bt.709";
    double peak = 203;
    std::string light = "auto";
    bool operator==(const Profile &other) const {
        return transfer == other.transfer && primaries == other.primaries && light == other.light && std::abs(peak - other.peak) < 0.01;
    }
};
inline double pq(double nits) {
    const double p = std::pow(std::max(0.0, nits) / 10000, 2610.0 / 16384);
    return std::pow((3424.0 / 4096 + 2413.0 / 128 * p) / (1 + 2392.0 / 128 * p), 2523.0 / 32);
}
inline double pqInverse(double code) {
    const double p = std::pow(std::max(0.0, code), 32.0 / 2523);
    return 10000 * std::pow(std::max(p - 3424.0 / 4096, 0.0) / (2413.0 / 128 - 2392.0 / 128 * p), 16384.0 / 2610);
}
inline double srgb(double linear) {
    linear = std::clamp(linear, 0.0, 1.0);
    return linear <= 0.0031308 ? 12.92 * linear : 1.055 * std::pow(linear, 1 / 2.4) - 0.055;
}
inline double bt2390(double nits, double peak) {
    if (peak <= 203) return nits;
    const double p = pq(peak), maximum = pq(203) / p, knee = 1.5 * maximum - 0.5;
    double x = pq(std::min(nits, peak)) / p;
    if (x >= knee) {
        const double t = (x - knee) / (1 - knee), t2 = t * t, t3 = t2 * t;
        x = (2 * t3 - 3 * t2 + 1) * knee + (t3 - 2 * t2 + t) * (1 - knee) + (-2 * t3 + 3 * t2) * maximum;
    }
    return pqInverse(x * p);
}
inline RGB convert(RGB value, const Profile &profile) {
    const auto source = rgbToXyz(profile.primaries);
    const auto luma = source[1];
    for (auto &v : value) {
        if (profile.transfer == "pq") v = pqInverse(v) / 203;
        else if (profile.transfer == "hlg") v = (v <= 0.5 ? v * v / 3 : (std::exp((v - 0.55991073) / 0.17883277) + 0.28466892) / 12);
        else if (profile.transfer == "srgb") v = v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4);
        else if (profile.transfer == "prophoto") v = v <= .03125 ? v / 16 : std::pow(v, 1.8);
        else if (profile.transfer == "st428") v = 52.37 / 48 * std::pow(v, 2.6);
        else if (profile.transfer == "v-log") v = v <= .181 ? (v - .125) / 5.6 : std::pow(10, (v - .598206) / .241514) - .00873;
        else if (profile.transfer == "s-log1") v = std::pow(10, (v - .646596) / .432699) - .037584;
        else if (profile.transfer == "s-log2") v = v <= .030001 ? (v - .030001) / 3.538813 : (std::pow(10, (v - .646596) / .432699) - .037584) / (155.0 / 219);
        else if (profile.transfer != "linear") {
            double gamma = 2.4;
            if (profile.transfer == "gamma1.8") gamma = 1.8;
            if (profile.transfer == "gamma2.0") gamma = 2.0;
            if (profile.transfer == "gamma2.2") gamma = 2.2;
            if (profile.transfer == "gamma2.6") gamma = 2.6;
            if (profile.transfer == "gamma2.8") gamma = 2.8;
            v = std::pow(v, gamma);
        }
    }
    if (profile.transfer == "hlg" && (profile.light == "hlg" || profile.light == "auto")) {
        const double gamma = std::max(1.0, 1.2 + 0.42 * std::log10(profile.peak / 1000));
        const double brightness = value[0] * luma[0] + value[1] * luma[1] + value[2] * luma[2];
        const double scale = profile.peak / 203 * std::pow(brightness, gamma - 1);
        for (auto &v : value) v *= scale;
    } else {
        if (profile.transfer == "hlg") for (auto &v : value) v *= 12 / 3.17955;
        if (profile.light == "gamma1.2") for (auto &v : value) v = std::pow(std::max(0.0, v), 1.2);
        if (profile.light == "709-1886") for (auto &v : value)
            v = std::pow(v <= .0181 ? 4.5 * v : 1.0993 * std::pow(v, .45) - .0993, 2.4);
    }
    if (profile.peak > 203) {
        const size_t dominant = std::max_element(value.begin(), value.end()) - value.begin();
        RGB mapped;
        for (size_t i = 0; i < 3; i++) mapped[i] = bt2390(value[i] * 203, profile.peak) / 203;
        const double coefficient = 0.90 * std::pow(std::max(mapped[dominant] - 0.18, 1e-6) / std::max(mapped[dominant], 1.0), 0.20);
        const double scale = value[dominant] > 0 ? mapped[dominant] / value[dominant] : 0;
        for (size_t i = 0; i < 3; i++) value[i] = value[i] * scale * (1 - coefficient) + mapped[i] * coefficient;
    }
    // Relative colorimetric gamut conversion followed by mpv's desaturation.
    if (profile.primaries != "bt.709") {
        auto xyz = multiply(source, value);
        const auto sourceWhite = white(profile.primaries), targetWhite = white("bt.709");
        if (sourceWhite != targetWhite) {
            const Matrix bradford{{{.8951, .2664, -.1614}, {-.7502, 1.7135, .0367}, {.0389, -.0685, 1.0296}}};
            auto cones = multiply(bradford, xyz);
            const auto from = multiply(bradford, sourceWhite), to = multiply(bradford, targetWhite);
            for (int i = 0; i < 3; i++) cones[i] *= to[i] / from[i];
            xyz = multiply(inverse(bradford), cones);
        }
        value = multiply(inverse(rgbToXyz("bt.709")), xyz);
        const double minimum = *std::min_element(value.begin(), value.end());
        if (minimum < 0) {
            const double y = value[0] * 0.21263901 + value[1] * 0.71516868 + value[2] * 0.07219232;
            const double amount = minimum / (minimum - y);
            for (auto &v : value) v = v * (1 - amount) + y * amount;
        }
        const double maximum = *std::max_element(value.begin(), value.end());
        if (maximum > 1) for (auto &v : value) v /= maximum;
    }
    for (auto &v : value) v = srgb(v);
    return value;
}
class LutFiles {
    std::filesystem::path directory;
public:
    ~LutFiles() { clear(); }
    void clear() {
        if (!directory.empty()) { std::error_code ignored; std::filesystem::remove_all(directory, ignored); directory.clear(); }
    }
    std::string write(const Profile &profile, int slot) {
        const std::string output = ",setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=full";
        if ((profile.primaries == "bt.709" || profile.primaries == "auto")
            && (profile.transfer == "bt.1886" || profile.transfer == "auto")
            && (profile.light == "auto" || profile.light == "display") && profile.peak <= 203) {
            // With identical primaries and no tone mapping, the transform is
            // separable: sRGB(pow(encoded, 2.4)). Keep the 16-bit intermediate
            // to avoid quantizing before the final software scaler/output.
            // The upper sRGB branch cancels the 2.4 powers algebraically.
            const std::string curve = "maxval*if(lte(pow(val/maxval,2.4),0.0031308),12.92*pow(val/maxval,2.4),1.055*val/maxval-0.055)";
            const auto graph = "format=gbrp16le,lutrgb=r='" + curve + "':g='" + curve + "':b='" + curve + "'" + output;
            // Leave CPU time for software decoding, scaling and Canvas. The
            // filter graph otherwise creates its own machine-wide thread pool.
            const auto available = std::thread::hardware_concurrency();
            const auto options = "threads=" + std::to_string(std::clamp(available ? available / 2 : 1u, 1u, 4u));
            return "lavfi=graph=%" + std::to_string(graph.size()) + "%" + graph
                + ":o=%" + std::to_string(options.size()) + "%" + options;
        }
        if (directory.empty()) {
            std::random_device random;
            for (int attempt = 0; attempt < 8; attempt++) {
                auto path = std::filesystem::temp_directory_path() / ("javdex-color-" + std::to_string(random()) + "-" + std::to_string(random()));
                if (std::filesystem::create_directory(path)) { directory = path; break; }
            }
            if (directory.empty()) throw std::runtime_error("Cannot create playback color directory");
        }
        const auto path = directory / (std::to_string(slot) + ".cube");
        std::ofstream file(path); file.imbue(std::locale::classic()); file << std::setprecision(9);
        constexpr int size = 33;
        file << "LUT_3D_SIZE " << size << '\n';
        for (int b = 0; b < size; b++) for (int g = 0; g < size; g++) for (int r = 0; r < size; r++) {
            const auto v = convert({r / double(size - 1), g / double(size - 1), b / double(size - 1)}, profile);
            file << v[0] << ' ' << v[1] << ' ' << v[2] << '\n';
        }
        file.close();
        if (!file) throw std::runtime_error("Cannot write playback color LUT");
        // FFmpeg option escaping, then graph escaping. mpv's length-quoted
        // graph avoids a third quoting language and handles UTF-8 user paths,
        // including apostrophes, commas, brackets and Windows drive letters.
        std::string option, escaped;
        for (const char c : path.generic_u8string()) { if (c == ':' || c == '\'' || c == '\\') option += '\\'; option += c; }
        for (const char c : option) { if (std::string("\\'[],;").find(c) != std::string::npos) escaped += '\\'; escaped += c; }
        const std::string graph = "format=gbrp16le,lut3d=file=" + escaped + ":interp=tetrahedral" + output;
        return "lavfi=graph=%" + std::to_string(graph.size()) + "%" + graph;
    }
};
}
