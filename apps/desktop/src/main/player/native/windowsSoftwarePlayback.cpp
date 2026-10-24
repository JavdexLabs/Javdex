// CPU decode and libmpv SW rendering. No HWND, GL context, D3D device or GPU
// handles: the sandbox preload presents copied RGBA pixels with putImageData.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <malloc.h>
#include "mpvCore.h"
#include <algorithm>

namespace {
using namespace javdex;
MpvCore playback;
DWORD ownerThread = 0;
bool visible = false, dirty = true;
int width = 1, height = 1;
size_t stride = 64, capacity = 0;
unsigned char *pixels = nullptr;
uint64_t sequence = 0;
constexpr int maxDimension = 8192;
constexpr size_t maxBufferBytes = 256ULL * 1024 * 1024;
void requireOwner() {
    if (ownerThread != GetCurrentThreadId()) throw std::runtime_error("CPU playback requires its owner thread");
}
void shutdown() {
    playback.shutdown();
    _aligned_free(pixels); pixels = nullptr; capacity = 0;
    visible = false; dirty = true; width = height = 1; stride = 64;
}
void bounds(napi_env env, napi_value value) {
    const double w = namedNumber(env, value, "width"), h = namedNumber(env, value, "height"), scale = namedNumber(env, value, "scale");
    if (w <= 0 || h <= 0 || scale <= 0 || scale > 8)
        throw std::runtime_error("Invalid CPU playback bounds");
    // Match Linux CPU playback: render the physical viewport without a quality
    // cap, retaining only the dimension and frame-memory safety boundaries.
    const double pw = std::round(w * scale), ph = std::round(h * scale);
    if (!std::isfinite(pw) || !std::isfinite(ph) || pw < 1 || ph < 1 || pw > maxDimension || ph > maxDimension)
        throw std::runtime_error("CPU viewport exceeds supported dimensions");
    const int nextWidth = static_cast<int>(pw), nextHeight = static_cast<int>(ph);
    const size_t nextStride = (static_cast<size_t>(nextWidth) * 4 + 63) & ~size_t(63);
    if (nextStride * nextHeight > maxBufferBytes) throw std::runtime_error("CPU frame exceeds memory limit");
    if (width != nextWidth || height != nextHeight) {
        width = nextWidth; height = nextHeight;
        stride = nextStride; dirty = true;
    }
}
napi_value create(napi_env env, napi_callback_info info) {
    try {
        if (ownerThread) requireOwner();
        ownerThread = GetCurrentThreadId(); shutdown();
        size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("Expected CPU playback bounds");
        bounds(env, args[0]);
        playback.initialize(nullptr, nullptr, false, nullptr, nullptr, "no", true);
        return undefined(env);
    } catch (const std::exception &error) {
        if (ownerThread == GetCurrentThreadId()) shutdown();
        return fail(env, error.what());
    }
}
napi_value setBounds(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("Expected CPU playback bounds");
        bounds(env, args[0]); return undefined(env);
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value setVisible(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); size_t count = 1; napi_value args[1]; bool next = false;
        napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1 || napi_get_value_bool(env, args[0], &next) != napi_ok) throw std::runtime_error("Invalid CPU visibility");
        if (visible != next) dirty = true;
        visible = next; return undefined(env);
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value nextFrame(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); if (!playback.alive()) return undefined(env);
        size_t count = 1; napi_value args[1]; bool writable = false;
        napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1 || napi_get_value_bool(env, args[0], &writable) != napi_ok) throw std::runtime_error("Invalid CPU frame budget");
        const bool updated = playback.updateRequested(); dirty = dirty || updated;
        if (!visible || !writable) {
            if (updated && !playback.skipRender()) throw std::runtime_error("Cannot skip CPU frame");
            return undefined(env);
        }
        if (!dirty) return undefined(env);
        const size_t size = stride * height;
        if (capacity < size) {
            _aligned_free(pixels); pixels = nullptr; capacity = 0;
            pixels = static_cast<unsigned char *>(_aligned_malloc(size, 64));
            if (!pixels) throw std::runtime_error("Cannot allocate CPU frame");
            capacity = size;
        }
        const auto delay = playback.nextFrameDelayUs();
        if (!playback.renderSoftware(width, height, stride, pixels)) throw std::runtime_error("Cannot render CPU frame");
        for (int y = 0; y < height; y++) {
            auto *row = pixels + static_cast<size_t>(y) * stride;
            for (int x = 0; x < width; x++) row[x * 4 + 3] = 255;
            // Never expose uninitialized row padding over IPC.
            std::fill(row + width * 4, row + stride, static_cast<unsigned char>(0));
        }
        napi_value result, buffer; napi_create_object(env, &result);
        if (napi_create_buffer_copy(env, size, pixels, nullptr, &buffer) != napi_ok) throw std::runtime_error("Cannot copy CPU frame");
        napi_set_named_property(env, result, "pixels", buffer);
        setNumber(env, result, "width", width); setNumber(env, result, "height", height);
        setNumber(env, result, "stride", static_cast<double>(stride)); setNumber(env, result, "size", static_cast<double>(size));
        setNumber(env, result, "sequence", static_cast<double>(++sequence));
        setNumber(env, result, "delayUs", static_cast<double>(delay));
        dirty = false; return result;
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value command(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); size_t count = 2; napi_value args[2]; bool generated = false;
        napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (!count || !playback.alive()) throw std::runtime_error("No CPU playback session");
        if (count > 1 && napi_get_value_bool(env, args[1], &generated) != napi_ok) throw std::runtime_error("Invalid subtitle scope");
        playback.command(env, args[0], generated); dirty = true; return undefined(env);
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value read(napi_env env, bool drain) {
    try {
        if (ownerThread) requireOwner();
        auto result = playback.state(env, drain);
        setString(env, result, "backend", "windows-software");
        setNumber(env, result, "pixelWidth", playback.alive() ? width : 0);
        setNumber(env, result, "pixelHeight", playback.alive() ? height : 0);
        return result;
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value state(napi_env env, napi_callback_info) { return read(env, true); }
napi_value inspect(napi_env env, napi_callback_info) { return read(env, false); }
napi_value generatedSubtitles(napi_env env, napi_callback_info info) {
    try { requireOwner(); playback.generatedSubtitles(env, info); dirty = true; return undefined(env); }
    catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value destroy(napi_env env, napi_callback_info) {
    try { if (ownerThread) requireOwner(); shutdown(); return undefined(env); }
    catch (const std::exception &error) { return fail(env, error.what()); }
}
void cleanup(void *) { shutdown(); }
}
napi_value initializeWindowsSoftwarePlayback(napi_env env, napi_value exports) {
    napi_value software; napi_create_object(env, &software);
    napi_property_descriptor methods[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBounds", nullptr, setBounds, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setVisible", nullptr, setVisible, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nextFrame", nullptr, nextFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"command", nullptr, command, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"generatedSubtitles", nullptr, generatedSubtitles, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"state", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroy", nullptr, destroy, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, software, sizeof(methods) / sizeof(methods[0]), methods);
    napi_set_named_property(env, exports, "software", software);
    napi_add_env_cleanup_hook(env, cleanup, nullptr); return exports;
}
