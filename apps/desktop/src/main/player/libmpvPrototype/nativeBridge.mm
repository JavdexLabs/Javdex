// Throwaway macOS feasibility probe, not a production playback adapter.
#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>
#include <node_api.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <dlfcn.h>
#include <cmath>
#include <atomic>
#include <cstring>
#include <map>
#include <string>
#include <vector>

struct ObservedValue {
    mpv_format format = MPV_FORMAT_NONE;
    double number = 0;
    std::string text;
};

@interface JavdexMpvView : NSOpenGLView {
@public
    mpv_handle *core;
    mpv_render_context *renderer;
    BOOL closed;
    uint64_t frames;
    int pixelWidth;
    int pixelHeight;
}
- (void)renderFrame;
@end

static JavdexMpvView *playerView;
static std::map<std::string, ObservedValue> observed;
static std::string lastError;
static uint64_t loadedFiles;
static uint64_t restartedPlayback;
static uint64_t commandErrors;
static std::atomic<bool> renderRequested{false};

static void *getProcAddress(void *, const char *name) {
    return dlsym(RTLD_DEFAULT, name);
}

static void requestRender(void *) {
    // mpv owns this thread. Only notify; the Electron main-loop tick performs
    // rendering. Continuous GCD/AppKit display callbacks can starve Node's
    // control/event pump, so do not schedule one dispatch block per video frame.
    renderRequested.store(true);
}

@implementation JavdexMpvView
- (BOOL)isOpaque { return YES; }
- (void)reshape {
    [super reshape];
    [[self openGLContext] update];
}
- (void)renderFrame {
    if (closed || !renderer) return;
    [[self openGLContext] makeCurrentContext];
    NSRect pixels = [self convertRectToBacking:self.bounds];
    pixelWidth = (int)pixels.size.width;
    pixelHeight = (int)pixels.size.height;
    if (pixelWidth <= 0 || pixelHeight <= 0) return;
    mpv_render_context_update(renderer);
    mpv_opengl_fbo fbo = {0, pixelWidth, pixelHeight, 0};
    int flip = 1, block = 0;
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
        {MPV_RENDER_PARAM_FLIP_Y, &flip},
        {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block},
        {MPV_RENDER_PARAM_INVALID, nullptr}
    };
    mpv_render_context_render(renderer, params);
    frames++;
}
- (void)drawRect:(NSRect)rect {
    (void)rect;
    [self renderFrame];
    if (!closed && renderer) {
        [[self openGLContext] flushBuffer];
        mpv_render_context_report_swap(renderer);
    }
}
@end

static napi_value fail(napi_env env, const std::string &message) {
    napi_throw_error(env, nullptr, message.c_str());
    return nullptr;
}
static napi_value undefined(napi_env env) {
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
}
static std::string stringArg(napi_env env, napi_value value) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return {};
    std::vector<char> data(length + 1);
    napi_get_value_string_utf8(env, value, data.data(), data.size(), &length);
    return std::string(data.data(), length);
}
static void setNumber(napi_env env, napi_value object, const char *key, double value) {
    napi_value js;
    if (std::isfinite(value)) napi_create_double(env, value, &js);
    else napi_get_null(env, &js);
    napi_set_named_property(env, object, key, js);
}
static void setString(napi_env env, napi_value object, const char *key, const std::string &value) {
    napi_value js;
    napi_create_string_utf8(env, value.c_str(), value.size(), &js);
    napi_set_named_property(env, object, key, js);
}
static void setFlag(napi_env env, napi_value object, const char *key, bool value) {
    napi_value js;
    napi_get_boolean(env, value, &js);
    napi_set_named_property(env, object, key, js);
}
static double namedNumber(napi_env env, napi_value object, const char *key) {
    napi_value value;
    double result = 0;
    napi_get_named_property(env, object, key, &value);
    napi_get_value_double(env, value, &result);
    return result;
}
static void updateBounds(napi_env env, napi_value bounds) {
    NSView *host = playerView.superview;
    double x = namedNumber(env, bounds, "x");
    double y = namedNumber(env, bounds, "y");
    double width = namedNumber(env, bounds, "width");
    double height = namedNumber(env, bounds, "height");
    if (![host isFlipped]) y = host.bounds.size.height - y - height;
    [playerView setFrame:NSMakeRect(x, y, MAX(1, width), MAX(1, height))];
    [playerView reshape];
    [playerView setNeedsDisplay:YES];
    if (playerView->renderer) [playerView displayIfNeeded];
}
static void destroyPlayer() {
    if (!playerView) return;
    playerView->closed = YES;
    if (playerView->renderer) {
        mpv_render_context_set_update_callback(playerView->renderer, nullptr, nullptr);
        [[playerView openGLContext] makeCurrentContext];
        mpv_render_context_free(playerView->renderer);
        playerView->renderer = nullptr;
    }
    if (playerView->core) {
        mpv_terminate_destroy(playerView->core);
        playerView->core = nullptr;
    }
    [playerView removeFromSuperview];
    [NSOpenGLContext clearCurrentContext];
    playerView = nil;
    renderRequested.store(false);
}
static void cleanup(void *) { destroyPlayer(); }

static napi_value create(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2 || ![NSThread isMainThread]) return fail(env, "create requires main thread, handle and bounds");
    destroyPlayer();
    void *data = nullptr;
    size_t size = 0;
    if (napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(void *)) {
        return fail(env, "Invalid native window handle");
    }
    void *pointer;
    std::memcpy(&pointer, data, sizeof(pointer));
    NSView *host = (__bridge NSView *)pointer;
    NSOpenGLPixelFormatAttribute attributes[] = {
        NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
        NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated,
        NSOpenGLPFAColorSize, 24, NSOpenGLPFAAlphaSize, 8, 0
    };
    NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
    if (!format) return fail(env, "Cannot create native OpenGL pixel format");
    playerView = [[JavdexMpvView alloc] initWithFrame:NSMakeRect(0, 0, 640, 360) pixelFormat:format];
    [playerView setWantsBestResolutionOpenGLSurface:YES];
    [host addSubview:playerView positioned:NSWindowAbove relativeTo:nil];
    updateBounds(env, args[1]);
    [[playerView openGLContext] makeCurrentContext];
    playerView->core = mpv_create();
    if (!playerView->core) { destroyPlayer(); return fail(env, "mpv_create failed"); }
    const char *options[][2] = {
        {"config", "no"}, {"load-scripts", "no"}, {"ytdl", "no"},
        {"vo", "libmpv"}, {"hwdec", "auto"}, {"idle", "yes"},
        {"keep-open", "yes"}, {"pause", "yes"}, {"volume", "15"}, {"terminal", "no"},
        {"video-timing-offset", "0"}
    };
    for (const auto &option : options) {
        int error = mpv_set_option_string(playerView->core, option[0], option[1]);
        if (error < 0) {
            std::string message = std::string(option[0]) + ": " + mpv_error_string(error);
            destroyPlayer(); return fail(env, message);
        }
    }
    int error = mpv_initialize(playerView->core);
    if (error < 0) { destroyPlayer(); return fail(env, mpv_error_string(error)); }
    mpv_opengl_init_params gl = {getProcAddress, nullptr};
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl}, {MPV_RENDER_PARAM_INVALID, nullptr}
    };
    error = mpv_render_context_create(&playerView->renderer, playerView->core, params);
    if (error < 0) { destroyPlayer(); return fail(env, mpv_error_string(error)); }
    observed.clear(); lastError.clear(); loadedFiles = 0; restartedPlayback = 0; commandErrors = 0;
    const char *numbers[] = {"time-pos", "duration", "volume", "width", "height", "audio-pts", "frame-drop-count"};
    const char *strings[] = {"hwdec-current", "video-codec", "audio-codec", "audio-device", "current-ao"};
    const char *flags[] = {"pause", "eof-reached", "core-idle"};
    for (const char *name : numbers) mpv_observe_property(playerView->core, 0, name, MPV_FORMAT_DOUBLE);
    for (const char *name : strings) mpv_observe_property(playerView->core, 0, name, MPV_FORMAT_STRING);
    for (const char *name : flags) mpv_observe_property(playerView->core, 0, name, MPV_FORMAT_FLAG);
    mpv_render_context_set_update_callback(playerView->renderer, requestRender, (__bridge void *)playerView);
    return undefined(env);
}
static napi_value bounds(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (playerView && argc == 1) updateBounds(env, args[0]);
    return undefined(env);
}
static napi_value visible(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1]; bool value = false;
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc == 1) napi_get_value_bool(env, args[0], &value);
    if (playerView) [playerView setHidden:!value];
    return undefined(env);
}
static napi_value command(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (!playerView || playerView->closed) return fail(env, "No native playback session");
    if (argc != 1) return fail(env, "Expected one command array");
    bool array = false; napi_is_array(env, args[0], &array);
    if (!array) return fail(env, "Expected command array");
    uint32_t length = 0; napi_get_array_length(env, args[0], &length);
    if (length == 0 || length > 8) return fail(env, "Invalid command length");
    std::vector<std::string> values;
    for (uint32_t i = 0; i < length; i++) {
        napi_value value; napi_get_element(env, args[0], i, &value);
        values.push_back(stringArg(env, value));
    }
    std::vector<const char *> commandArgs;
    for (const auto &value : values) commandArgs.push_back(value.c_str());
    commandArgs.push_back(nullptr);
    // No synchronous client calls on the OpenGL/AppKit render thread.
    int error = mpv_command_async(playerView->core, 0, commandArgs.data());
    if (error < 0) return fail(env, mpv_error_string(error));
    return undefined(env);
}
static napi_value state(napi_env env, napi_callback_info) {
    napi_value result; napi_create_object(env, &result);
    bool alive = playerView && !playerView->closed;
    setFlag(env, result, "alive", alive);
    if (!alive) return result;
    while (true) {
        mpv_event *event = mpv_wait_event(playerView->core, 0);
        if (event->event_id == MPV_EVENT_NONE) break;
        if (event->event_id == MPV_EVENT_PROPERTY_CHANGE) {
            auto *property = (mpv_event_property *)event->data;
            ObservedValue value; value.format = property->format;
            if (property->data) {
                if (property->format == MPV_FORMAT_DOUBLE) value.number = *(double *)property->data;
                if (property->format == MPV_FORMAT_FLAG) value.number = *(int *)property->data;
                if (property->format == MPV_FORMAT_STRING) value.text = *(char **)property->data;
            }
            observed[property->name] = value;
        }
        if (event->event_id == MPV_EVENT_FILE_LOADED) loadedFiles++;
        if (event->event_id == MPV_EVENT_PLAYBACK_RESTART) restartedPlayback++;
        if (event->event_id == MPV_EVENT_COMMAND_REPLY && event->error < 0) {
            commandErrors++; lastError = mpv_error_string(event->error);
        }
        if (event->event_id == MPV_EVENT_END_FILE) {
            auto *end = (mpv_event_end_file *)event->data;
            if (end->error < 0) lastError = mpv_error_string(end->error);
        }
    }
    for (const auto &[key, value] : observed) {
        if (value.format == MPV_FORMAT_DOUBLE) setNumber(env, result, key.c_str(), value.number);
        if (value.format == MPV_FORMAT_FLAG) setFlag(env, result, key.c_str(), value.number != 0);
        if (value.format == MPV_FORMAT_STRING) setString(env, result, key.c_str(), value.text);
    }
    setNumber(env, result, "nativeFrames", playerView->frames);
    setNumber(env, result, "pixelWidth", playerView->pixelWidth);
    setNumber(env, result, "pixelHeight", playerView->pixelHeight);
    setNumber(env, result, "loadedFiles", loadedFiles);
    setNumber(env, result, "playbackRestarts", restartedPlayback);
    setNumber(env, result, "commandErrors", commandErrors);
    setString(env, result, "error", lastError);
    return result;
}
static napi_value capture(napi_env env, napi_callback_info) {
    if (!playerView || playerView->closed) return fail(env, "No native playback session");
    // One-shot diagnostic readback only; ordinary playback never copies frames to JS.
    [playerView renderFrame];
    int width = playerView->pixelWidth, height = playerView->pixelHeight;
    std::vector<unsigned char> rgba((size_t)width * height * 4);
    glReadBuffer(GL_BACK);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
    std::vector<unsigned char> bgra(rgba.size());
    for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
        size_t target = ((size_t)y * width + x) * 4;
        size_t source = ((size_t)(height - y - 1) * width + x) * 4;
        bgra[target] = rgba[source + 2]; bgra[target + 1] = rgba[source + 1];
        bgra[target + 2] = rgba[source]; bgra[target + 3] = 255;
    }
    [[playerView openGLContext] flushBuffer];
    mpv_render_context_report_swap(playerView->renderer);
    napi_value result, buffer; napi_create_object(env, &result);
    napi_create_buffer_copy(env, bgra.size(), bgra.data(), nullptr, &buffer);
    napi_set_named_property(env, result, "data", buffer);
    setNumber(env, result, "width", width); setNumber(env, result, "height", height);
    return result;
}
static napi_value render(napi_env env, napi_callback_info) {
    if (playerView && !playerView->closed && renderRequested.exchange(false)) {
        [[playerView openGLContext] makeCurrentContext];
        uint64_t flags = mpv_render_context_update(playerView->renderer);
        if (flags & MPV_RENDER_UPDATE_FRAME) [playerView drawRect:playerView.bounds];
    }
    return undefined(env);
}
static napi_value destroy(napi_env env, napi_callback_info) { destroyPlayer(); return undefined(env); }
static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBounds", nullptr, bounds, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setVisible", nullptr, visible, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"command", nullptr, command, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"state", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"render", nullptr, render, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"capture", nullptr, capture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroy", nullptr, destroy, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    napi_add_env_cleanup_hook(env, cleanup, nullptr);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
