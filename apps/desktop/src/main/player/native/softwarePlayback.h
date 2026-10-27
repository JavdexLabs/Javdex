#pragma once
// CPU decode and libmpv SW rendering. No native window, GL context or GPU
// handles: the sandbox preload presents opaque RGBX frames through video.
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <malloc.h>
#if defined(_M_X64) || defined(_M_IX86)
#include <emmintrin.h>
#endif
#else
#include <thread>
#endif
#include "mpvCore.h"
#include <uv.h>
#include <algorithm>
#include <cstdlib>

namespace javdex_software {
using namespace javdex;
MpvCore playback;
#ifdef _WIN32
using OwnerThread = DWORD;
OwnerThread currentOwner() { return GetCurrentThreadId(); }
#else
using OwnerThread = std::thread::id;
OwnerThread currentOwner() { return std::this_thread::get_id(); }
#endif
OwnerThread ownerThread{};
const char *backend = nullptr;
bool visible = false, dirty = true;
int width = 1, height = 1;
size_t stride = 64, capacity = 0;
unsigned char *pixels = nullptr;
uint64_t sequence = 0, timeline = 0;
#ifdef _WIN32
struct CpuTiming {
    uint64_t count = 0; double total = 0, maximum = 0, last = 0;
    void record(uint64_t nanoseconds) {
        last = static_cast<double>(nanoseconds) / 1000000.0; ++count; total += last; maximum = std::max(maximum, last);
    }
    napi_value snapshot(napi_env env) const {
        napi_value value; napi_create_object(env, &value);
        setNumber(env, value, "samples", count); setNumber(env, value, "totalMs", total);
        setNumber(env, value, "meanMs", count ? total / count : 0); setNumber(env, value, "maxMs", maximum);
        setNumber(env, value, "lastMs", last); return value;
    }
};
bool cpuDiagnostics = false;
CpuTiming cpuAllocate, cpuRender, cpuSanitize, cpuCopy;
#endif
void requireOwner() {
    if (ownerThread != currentOwner()) throw std::runtime_error("CPU playback requires its owner thread");
}
void releasePixels() {
#ifdef _WIN32
    _aligned_free(pixels);
#else
    std::free(pixels);
#endif
    pixels = nullptr; capacity = 0;
}
void shutdown() {
    playback.shutdown();
    releasePixels();
    visible = false; dirty = true; width = height = 1; stride = 64;
    timeline = 0;
}
void bounds(napi_env env, napi_value value) {
    const auto next = frameLayout(namedNumber(env, value, "width"), namedNumber(env, value, "height"), namedNumber(env, value, "scale"));
    if (width != next.width || height != next.height) {
        width = next.width; height = next.height; stride = next.stride; dirty = true;
    }
}
napi_value create(napi_env env, napi_callback_info info) {
    try {
        if (ownerThread != OwnerThread{}) requireOwner();
        ownerThread = currentOwner(); shutdown();
        size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("Expected CPU playback bounds");
        bounds(env, args[0]);
#ifdef _WIN32
        const char *diagnostics = std::getenv("JAVDEX_PLAYBACK_DIAGNOSTICS");
        cpuDiagnostics = diagnostics && std::string(diagnostics) == "1";
        cpuAllocate = {}; cpuRender = {}; cpuSanitize = {}; cpuCopy = {};
#endif
        RenderConfig config; config.cpu = true; config.hardwareDecode = "no";
        playback.initialize(config);
        return undefined(env);
    } catch (const std::exception &error) {
        if (ownerThread == currentOwner()) shutdown();
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
napi_value resetTiming(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); size_t count = 1; napi_value args[1]; double value = 0;
        napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value)
            || value <= timeline || value > 9007199254740991.0 || std::floor(value) != value) throw std::runtime_error("Invalid CPU timeline");
        timeline = static_cast<uint64_t>(value); dirty = true; return undefined(env);
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value setRenderBudget(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); size_t count = 1; napi_value args[1]; double value = 0;
        napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value) || value < 8 || value > 40)
            throw std::runtime_error("Invalid CPU render budget");
        playback.command({"set", "video-timing-offset", std::to_string(value / 1000)}); return undefined(env);
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
#ifdef _WIN32
        auto step = cpuDiagnostics ? uv_hrtime() : 0;
#endif
#ifdef _WIN32
        // Each JavaScript-owned allocation is a distinct frame. The utility's
        // two credits bound production; GC owns its lifetime after delivery.
        // Render into its aligned view instead of copying from scratch.
        napi_value storage, arrayBuffer, buffer; void *raw = nullptr;
        if (napi_create_buffer(env, size + 63, &raw, &storage) != napi_ok || !raw)
            throw std::runtime_error("Cannot allocate CPU output frame");
        napi_typedarray_type type; size_t length = 0, offset = 0, backingSize = 0; void *view = nullptr, *backing = nullptr;
        if (napi_get_typedarray_info(env, storage, &type, &length, &view, &arrayBuffer, &offset) != napi_ok
            || napi_get_arraybuffer_info(env, arrayBuffer, &backing, &backingSize) != napi_ok
            || type != napi_uint8_array || length != size + 63 || offset != 0 || backingSize != size + 63 || view != raw || backing != raw)
            throw std::runtime_error("Unexpected CPU output buffer backing");
        const auto aligned = (reinterpret_cast<uintptr_t>(raw) + 63) & ~static_cast<uintptr_t>(63);
        const size_t prefix = aligned - reinterpret_cast<uintptr_t>(raw);
        auto *framePixels = reinterpret_cast<unsigned char *>(aligned);
        // Structured cloning can include the complete ArrayBuffer, not just
        // the typed view. Never expose allocator bytes around the frame.
        std::memset(raw, 0, prefix);
        std::memset(framePixels + size, 0, 63 - prefix);
        if (napi_create_typedarray(env, napi_uint8_array, size, arrayBuffer, prefix, &buffer) != napi_ok)
            throw std::runtime_error("Cannot create aligned CPU output view");
#else
        if (capacity < size) {
            releasePixels();
            void *allocation = nullptr;
            if (posix_memalign(&allocation, 64, size) == 0) pixels = static_cast<unsigned char *>(allocation);
            if (!pixels) throw std::runtime_error("Cannot allocate CPU frame");
            capacity = size;
        }
        auto *framePixels = pixels;
#endif
#ifdef _WIN32
        if (cpuDiagnostics) { const auto now = uv_hrtime(); cpuAllocate.record(now - step); step = now; }
#endif
        const auto delay = playback.nextFrameDelayUs();
        const auto start = static_cast<int64_t>(uv_hrtime() / 1000);
        if (!playback.renderSoftware(width, height, stride, framePixels)) throw std::runtime_error("Cannot render CPU frame");
#ifdef _WIN32
        if (cpuDiagnostics) { const auto now = uv_hrtime(); cpuRender.record(now - step); step = now; }
#endif
        for (int y = 0; y < height; y++) {
            auto *row = framePixels + static_cast<size_t>(y) * stride;
            int x = 0;
#if defined(_WIN32) && (defined(_M_X64) || defined(_M_IX86))
            const auto opaque = _mm_set1_epi32(static_cast<int>(0xff000000u));
            for (; x + 4 <= width; x += 4) {
                auto *p = reinterpret_cast<__m128i *>(row + x * 4);
                _mm_store_si128(p, _mm_or_si128(_mm_load_si128(p), opaque));
            }
#endif
            for (; x < width; x++) row[x * 4 + 3] = 255;
            // Never expose uninitialized row padding over IPC.
            std::fill(row + width * 4, row + stride, static_cast<unsigned char>(0));
        }
#ifdef _WIN32
        if (cpuDiagnostics) { const auto now = uv_hrtime(); cpuSanitize.record(now - step); step = now; }
#endif
        napi_value result; napi_create_object(env, &result);
#ifndef _WIN32
        napi_value buffer;
        if (napi_create_buffer_copy(env, size, framePixels, nullptr, &buffer) != napi_ok) throw std::runtime_error("Cannot copy CPU frame");
#endif
        napi_set_named_property(env, result, "pixels", buffer);
        setNumber(env, result, "timeline", timeline);
        setNumber(env, result, "renderStartUs", start); setNumber(env, result, "targetTimeUs", delay ? start + delay : 0);
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
        if (ownerThread != OwnerThread{}) requireOwner();
        auto result = playback.state(env, drain);
        setString(env, result, "backend", backend);
        setNumber(env, result, "pixelWidth", playback.alive() ? width : 0);
        setNumber(env, result, "pixelHeight", playback.alive() ? height : 0);
#ifdef _WIN32
        if (cpuDiagnostics) {
            napi_value timings; napi_create_object(env, &timings);
            napi_set_named_property(env, timings, "bufferAllocate", cpuAllocate.snapshot(env));
            napi_set_named_property(env, timings, "softwareRender", cpuRender.snapshot(env));
            napi_set_named_property(env, timings, "sanitize", cpuSanitize.snapshot(env));
            napi_set_named_property(env, timings, "outputCopy", cpuCopy.snapshot(env));
            napi_set_named_property(env, result, "producerTimings", timings);
        }
#endif
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
    try { if (ownerThread != OwnerThread{}) requireOwner(); shutdown(); return undefined(env); }
    catch (const std::exception &error) { return fail(env, error.what()); }
}
void cleanup(void *) { shutdown(); }
napi_value initialize(napi_env env, napi_value exports, const char *name) {
    backend = name;
    napi_value software; napi_create_object(env, &software);
    napi_property_descriptor methods[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBounds", nullptr, setBounds, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setVisible", nullptr, setVisible, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nextFrame", nullptr, nextFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resetTiming", nullptr, resetTiming, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setRenderBudget", nullptr, setRenderBudget, nullptr, nullptr, nullptr, napi_default, nullptr},
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
}
