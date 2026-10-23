// Experimental macOS producer, loaded only in Electron's main process.
// IOSurfaceRef never crosses application IPC: Electron retains/imports it here
// and Chromium owns the Mach-port transfer to GPU/renderer processes.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#include "mpvCore.h"
#include <uv.h>
#include <array>
#include <unordered_map>
#include <cstring>
#include <cmath>
#include <dlfcn.h>

namespace {
using namespace javdex;
MpvCore playback;
CGLContextObj context = nullptr;
struct Slot { IOSurfaceRef surface = nullptr; GLuint texture = 0, framebuffer = 0; uint64_t sequence = 0; int width = 0, height = 0; };
std::array<Slot, 3> slots;
// Retain each exported surface independently of the active GL context. A late
// consumer release after destroy cannot release/reuse a newer session's slot.
std::unordered_map<uint64_t, IOSurfaceRef> leases;
uint64_t sequence = 0, timeline = 0;
int width = 1, height = 1;
bool visible = false, dirty = true;
int64_t clockUs() { return static_cast<int64_t>(uv_hrtime() / 1000); }
void *getProc(void *, const char *name) { return dlsym(RTLD_DEFAULT, name); }
void dispose(Slot &slot) {
    if (slot.framebuffer) glDeleteFramebuffers(1, &slot.framebuffer);
    if (slot.texture) glDeleteTextures(1, &slot.texture);
    if (slot.surface) CFRelease(slot.surface);
    slot = {};
}
void shutdown() {
    if (context) {
        CGLSetCurrentContext(context);
        playback.shutdown();
        for (auto &slot : slots) dispose(slot);
        CGLSetCurrentContext(nullptr); CGLDestroyContext(context); context = nullptr;
    }
    visible = false; dirty = true;
}
void size(napi_env env, napi_value bounds) {
    const double scale = namedNumber(env, bounds, "scale");
    const double w = std::ceil(namedNumber(env, bounds, "width") * scale);
    const double h = std::ceil(namedNumber(env, bounds, "height") * scale);
    if (!std::isfinite(scale) || scale <= 0 || scale > 8 || !std::isfinite(w) || !std::isfinite(h)
        || w < 1 || h < 1 || w > 8192 || h > 8192 || w * h * 4 > 256 * 1024 * 1024)
        throw std::runtime_error("Invalid IOSurface bounds");
    if (width != w || height != h) { width = static_cast<int>(w); height = static_cast<int>(h); dirty = true; }
}
void prepare(Slot &slot) {
    if (slot.width == width && slot.height == height) return;
    dispose(slot);
    NSDictionary *properties = @{(id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @(0x42475241)}; // BGRA
    slot.surface = IOSurfaceCreate((__bridge CFDictionaryRef)properties);
    if (!slot.surface) throw std::runtime_error("Cannot allocate IOSurface");
    glGenTextures(1, &slot.texture); glBindTexture(GL_TEXTURE_RECTANGLE, slot.texture);
    const auto error = CGLTexImageIOSurface2D(context, GL_TEXTURE_RECTANGLE, GL_RGBA8, width, height,
        GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, slot.surface, 0);
    if (error != kCGLNoError) throw std::runtime_error("Cannot bind IOSurface OpenGL texture");
    glGenFramebuffers(1, &slot.framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, slot.framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, slot.texture, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) throw std::runtime_error("Incomplete IOSurface framebuffer");
    slot.width = width; slot.height = height;
}
napi_value create(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1 || ![NSThread isMainThread]) return fail(env, "IOSurface create requires main thread and bounds");
    shutdown(); timeline = 0;
    try {
        size(env, args[0]);
        CGLPixelFormatAttribute attributes[] = {kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
            kCGLPFAAccelerated, kCGLPFAColorSize, (CGLPixelFormatAttribute)24, kCGLPFAAlphaSize, (CGLPixelFormatAttribute)8, (CGLPixelFormatAttribute)0};
        CGLPixelFormatObj format = nullptr; GLint matches = 0;
        const auto chosen = CGLChoosePixelFormat(attributes, &format, &matches);
        if (chosen != kCGLNoError || !format) throw std::runtime_error("No accelerated macOS OpenGL pixel format");
        const auto made = CGLCreateContext(format, nullptr, &context); CGLDestroyPixelFormat(format);
        if (made != kCGLNoError || !context) throw std::runtime_error("Cannot create IOSurface render context");
        CGLSetCurrentContext(context);
        // Preserve macOS's existing hwdec=auto. This is not Linux auto-copy,
        // and IOSurface/OpenGL is not a claim of Metal or end-to-end zero-copy.
        playback.initialize(getProc, nullptr, false, nullptr, nullptr, "auto", false, "0.02", true);
    } catch (const std::exception &error) { shutdown(); return fail(env, error.what()); }
    return undefined(env);
}
napi_value bounds(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    try { if (count == 1) size(env, args[0]); } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value visibility(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; bool value = false; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1 || napi_get_value_bool(env, args[0], &value) != napi_ok) return fail(env, "Invalid visibility");
    if (visible != value) dirty = true;
    visible = value; return undefined(env);
}
napi_value reset(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; double value = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || value <= timeline
        || value > 9007199254740991.0 || std::floor(value) != value) return fail(env, "Invalid frame timeline");
    timeline = static_cast<uint64_t>(value); dirty = true; return undefined(env);
}
napi_value next(napi_env env, napi_callback_info info) {
    try {
        if (!context || !playback.alive()) return undefined(env);
        CGLSetCurrentContext(context);
        size_t count = 1; napi_value args[1]; bool pattern = false; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count && napi_get_value_bool(env, args[0], &pattern) != napi_ok) throw std::runtime_error("Invalid pattern request");
        const bool updated = playback.updateRequested();
        dirty = dirty || updated || pattern;
        if (!visible || leases.size() >= slots.size()) {
            if (updated && !playback.skipRender()) throw std::runtime_error("Cannot skip unavailable IOSurface frame");
            return undefined(env);
        }
        if (!dirty) return undefined(env);
        auto slot = std::find_if(slots.begin(), slots.end(), [](const Slot &s) { return !s.sequence || !leases.count(s.sequence); });
        if (slot == slots.end()) return undefined(env);
        prepare(*slot);
        const auto delay = pattern ? 0 : playback.nextFrameDelayUs(), start = clockUs();
        glBindFramebuffer(GL_FRAMEBUFFER, slot->framebuffer); glViewport(0, 0, width, height);
        glDisable(GL_SCISSOR_TEST); glClearColor(.25f, .75f, .5f, 1.f); glClear(GL_COLOR_BUFFER_BIT);
        if (!pattern && !playback.render(width, height, slot->framebuffer, false)) throw std::runtime_error("Cannot render IOSurface frame");
        // Completion is established before handing ownership to Chromium. Keep
        // this conservative synchronization until real-device fence validation.
        glFinish();
        if (glGetError() != GL_NO_ERROR) throw std::runtime_error("IOSurface render failed");
        if (sequence >= 9007199254740991ULL) throw std::runtime_error("Frame sequence exhausted");
        slot->sequence = ++sequence; CFRetain(slot->surface); leases.emplace(sequence, slot->surface); dirty = false;
        napi_value result, handle; napi_create_object(env, &result);
        napi_create_buffer_copy(env, sizeof(slot->surface), &slot->surface, nullptr, &handle);
        napi_set_named_property(env, result, "ioSurface", handle);
        setNumber(env, result, "sequence", sequence); setNumber(env, result, "timeline", timeline);
        setNumber(env, result, "width", width); setNumber(env, result, "height", height);
        setNumber(env, result, "renderStartUs", start); setNumber(env, result, "targetTimeUs", delay ? start + delay : 0);
        setFlag(env, result, "producerComplete", true); setString(env, result, "pixelFormat", "bgra");
        setString(env, result, "colorContract", "bt709-srgb-rgb-full");
        return result;
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value budget(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; double value = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value) || value < 8 || value > 40)
        return fail(env, "Invalid render budget");
    try { playback.command({"set", "video-timing-offset", std::to_string(value / 1000)}); }
    catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value release(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; double value = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || value < 1
        || value > 9007199254740991.0 || std::floor(value) != value) return fail(env, "Invalid release sequence");
    const auto found = leases.find(static_cast<uint64_t>(value));
    if (found != leases.end()) { CFRelease(found->second); leases.erase(found); }
    return undefined(env);
}
napi_value command(napi_env env, napi_callback_info info) {
    size_t count = 2; napi_value args[2]; bool generated = false; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (!count || !playback.alive()) return fail(env, "No shared playback session");
    if (count > 1 && napi_get_value_bool(env, args[1], &generated) != napi_ok) return fail(env, "Invalid command scope");
    try { playback.command(env, args[0], generated); } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value subtitles(napi_env env, napi_callback_info info) {
    try { playback.generatedSubtitles(env, info); } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value state(napi_env env, bool consume) {
    auto result = playback.state(env, consume);
    setNumber(env, result, "outstandingSurfaces", leases.size());
    napi_value tickets; napi_create_array_with_length(env, leases.size(), &tickets);
    uint32_t index = 0;
    for (const auto &entry : leases) {
        napi_value ticket; napi_create_double(env, entry.first, &ticket); napi_set_element(env, tickets, index++, ticket);
    }
    napi_set_named_property(env, result, "outstandingSurfaceSequences", tickets);
    setNumber(env, result, "pixelWidth", width); setNumber(env, result, "pixelHeight", height);
    return result;
}
napi_value inspect(napi_env env, napi_callback_info) { return state(env, false); }
napi_value read(napi_env env, napi_callback_info) { return state(env, true); }
napi_value destroy(napi_env env, napi_callback_info) { shutdown(); return undefined(env); }
void cleanup(void *) {
    shutdown();
    for (auto &entry : leases) CFRelease(entry.second);
    leases.clear();
}
napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBounds", nullptr, bounds, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setVisible", nullptr, visibility, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resetTiming", nullptr, reset, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nextFrame", nullptr, next, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setRenderBudget", nullptr, budget, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"releaseFrame", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"command", nullptr, command, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"generatedSubtitles", nullptr, subtitles, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"state", nullptr, read, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroy", nullptr, destroy, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    napi_add_env_cleanup_hook(env, cleanup, nullptr); return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
