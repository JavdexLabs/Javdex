#pragma once
// Shared libmpv owner (platform addon or isolated Linux helper). Platform adapters own their window/GL
// context and make that context current before initialize/render/shutdown.
#ifndef JAVDEX_STANDALONE_PLAYBACK
#include <node_api.h>
#endif
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <deque>
#include <iomanip>
#include <locale>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include "generatedSubtitles.h"

namespace javdex {
#ifndef JAVDEX_STANDALONE_PLAYBACK
inline napi_value undefined(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
inline napi_value fail(napi_env env, const std::string &message) { napi_throw_error(env, nullptr, message.c_str()); return nullptr; }
inline std::string stringArg(napi_env env, napi_value value) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) throw std::runtime_error("Expected a string");
    std::vector<char> buffer(length + 1);
    napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
    return std::string(buffer.data(), length);
}
inline void setNumber(napi_env env, napi_value object, const char *key, double number) {
    napi_value value;
    if (std::isfinite(number)) napi_create_double(env, number, &value); else napi_get_null(env, &value);
    napi_set_named_property(env, object, key, value);
}
inline void setString(napi_env env, napi_value object, const char *key, const std::string &string) {
    napi_value value; napi_create_string_utf8(env, string.c_str(), string.size(), &value); napi_set_named_property(env, object, key, value);
}
inline void setFlag(napi_env env, napi_value object, const char *key, bool flag) {
    napi_value value; napi_get_boolean(env, flag, &value); napi_set_named_property(env, object, key, value);
}
inline double namedNumber(napi_env env, napi_value object, const char *key) {
    napi_value value; double number = 0;
    if (napi_get_named_property(env, object, key, &value) != napi_ok || napi_get_value_double(env, value, &number) != napi_ok || !std::isfinite(number))
        throw std::runtime_error("Expected finite native geometry");
    return number;
}

#endif

// MPV_FORMAT_NODE data belongs to the event queue and expires on the next read.
// Copy it while consuming; inspect() must never call mpv_wait_event itself.
inline std::string jsonString(const char *input) {
    std::string result = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (const unsigned char *p = reinterpret_cast<const unsigned char *>(input ? input : ""); *p; p++) {
        if (*p == '"' || *p == '\\') { result += '\\'; result += static_cast<char>(*p); }
        else if (*p < 32) { result += "\\u00"; result += hex[*p >> 4]; result += hex[*p & 15]; }
        else result += static_cast<char>(*p);
    }
    return result + '"';
}
inline std::string nodeJson(const mpv_node &node) {
    switch (node.format) {
        case MPV_FORMAT_STRING: return jsonString(node.u.string);
        case MPV_FORMAT_FLAG: return node.u.flag ? "true" : "false";
        case MPV_FORMAT_INT64: return std::to_string(node.u.int64);
        case MPV_FORMAT_DOUBLE: {
            if (!std::isfinite(node.u.double_)) return "null";
            std::ostringstream value; value.imbue(std::locale::classic()); value << std::setprecision(17) << node.u.double_; return value.str();
        }
        case MPV_FORMAT_NODE_ARRAY:
        case MPV_FORMAT_NODE_MAP: {
            const bool map = node.format == MPV_FORMAT_NODE_MAP;
            std::string result = map ? "{" : "[";
            for (int i = 0; node.u.list && i < node.u.list->num; i++) {
                if (i) result += ',';
                if (map) result += jsonString(node.u.list->keys[i]) + ':';
                result += nodeJson(node.u.list->values[i]);
            }
            return result + (map ? '}' : ']');
        }
        default: return "null";
    }
}
struct ObservedValue { mpv_format format = MPV_FORMAT_NONE; double number = 0; std::string text; };
struct NativeAction { std::string kind; double value; };

inline bool optionalSubtitleCommand(const std::vector<std::string> &values) {
    if (values.empty()) return false;
    if (values[0] == "sub-add" || values[0] == "sub-reload" || values[0] == "sub-remove") return true;
    return values.size() > 1 && values[0] == "set" &&
        (values[1] == "sid" || values[1] == "sub-delay" || values[1] == "sub-font-size");
}

class MpvCore {
    mpv_handle *handle = nullptr;
    mpv_render_context *renderer = nullptr;
    std::atomic<bool> requested{false};
    std::atomic<void (*)(void *)> renderWakeup{nullptr};
    std::atomic<void *> renderWakeupContext{nullptr};
    std::map<std::string, ObservedValue> observed;
    std::deque<NativeAction> actions;
    std::string lastError;
    int lastErrorCode = 0;
    uint64_t frames = 0, presentedFrames = 0, loadedFiles = 0, restarts = 0, commandErrors = 0, subtitleCommandErrors = 0, subtitleCommandsPending = 0, subtitleCommandReplies = 0;
    uint64_t generatedSubtitleCommandErrors = 0, generatedSubtitleCommandsPending = 0, generatedSubtitleCommandReplies = 0;
    GeneratedTimeline generatedTimeline;
    bool generatedVisible = false, generatedFailed = false, generatedRefreshRequired = false;
    std::string generatedLastText;
    uint64_t generatedRevision = 0;
    int generatedWidth = 0, generatedHeight = 0;
    double osdWidth = 0, osdHeight = 0, osdLeft = 0, osdRight = 0, osdTop = 0, osdBottom = 0;
    void refreshGeneratedSubtitles() {
        if (!handle || generatedWidth <= 0 || generatedHeight <= 0 || generatedFailed) return;
        try {
            std::string text;
            const auto clock = observed.find("time-pos"), sid = observed.find("sid");
            if (generatedVisible && clock != observed.end() && clock->second.format == MPV_FORMAT_DOUBLE
                && std::isfinite(clock->second.number) && sid != observed.end() && sid->second.text == "no") {
                text = generatedTextAt(generatedTimeline, clock->second.number - number("sub-delay"));
                if (!text.empty()) {
                    const double sx = osdWidth > 0 ? generatedWidth / osdWidth : 1;
                    const double sy = osdHeight > 0 ? generatedHeight / osdHeight : 1;
                    const double videoHeight = std::max(1.0, generatedHeight - (osdTop + osdBottom) * sy);
                    const double scale = videoHeight / 1080;
                    const double center = (generatedWidth + (osdLeft - osdRight) * sx) / 2;
                    const double bottom = generatedHeight - osdBottom * sy - videoHeight * 0.05;
                    text = "{\\an2\\pos(" + std::to_string(center) + "," + std::to_string(bottom)
                        + ")\\fnMicrosoft YaHei\\bord" + std::to_string(2 * scale) + "\\shad" + std::to_string(scale)
                        + "\\1c&HFFFFFF&\\1a&H00&\\3c&H101010&\\3a&H00&\\4c&H000000&\\4a&H80&}"
                        + scaleGeneratedFonts(std::move(text), scale);
                }
            }
            const std::string key = text.empty() ? std::string() : std::to_string(generatedWidth) + "x" + std::to_string(generatedHeight) + text;
            if (!generatedRefreshRequired && key == generatedLastText) return;
            std::string name = "osd-overlay", format = text.empty() ? "none" : "ass-events";
            char *keys[] = {const_cast<char *>("name"), const_cast<char *>("id"), const_cast<char *>("format"),
                const_cast<char *>("data"), const_cast<char *>("res_x"), const_cast<char *>("res_y")};
            mpv_node values[6]{};
            values[0].format = MPV_FORMAT_STRING; values[0].u.string = name.data();
            values[1].format = MPV_FORMAT_INT64; values[1].u.int64 = 77;
            values[2].format = MPV_FORMAT_STRING; values[2].u.string = format.data();
            values[3].format = MPV_FORMAT_STRING; values[3].u.string = text.data();
            values[4].format = MPV_FORMAT_INT64; values[4].u.int64 = generatedWidth;
            values[5].format = MPV_FORMAT_INT64; values[5].u.int64 = generatedHeight;
            mpv_node_list fields{6, values, keys}; mpv_node command{};
            command.format = MPV_FORMAT_NODE_MAP; command.u.list = &fields;
            const int error = mpv_command_node_async(handle, 2, &command);
            if (error < 0) throw std::runtime_error(mpv_error_string(error));
            subtitleCommandsPending++; generatedSubtitleCommandsPending++;
            generatedLastText = key; generatedRefreshRequired = false;
        } catch (...) { generatedFailed = true; subtitleCommandErrors++; generatedSubtitleCommandErrors++; }
    }
    static void request(void *context) {
        auto core = static_cast<MpvCore *>(context);
        if (!core->requested.exchange(true)) {
            if (auto wakeup = core->renderWakeup.load()) wakeup(core->renderWakeupContext.load());
        }
    }
public:
    // Opt-in host event notification; render notifications alone do not cover
    // command replies, track/property changes or subtitle work while paused.
    void setEventWakeup(void (*wakeup)(void *), void *context) {
        if (handle) mpv_set_wakeup_callback(handle, wakeup, context);
    }
    bool alive() const { return handle && renderer; }
    uint64_t loads() const { return loadedFiles; }
    double number(const char *name) const {
        const auto found = observed.find(name);
        return found == observed.end() || !std::isfinite(found->second.number) ? 0 : found->second.number;
    }
    void initialize(void *(*getProc)(void *, const char *), void *context = nullptr, bool softwareRendering = false,
        void (*wakeup)(void *) = nullptr, void *wakeupContext = nullptr, const char *hardwareDecode = "auto", bool cpuRendering = false,
        const char *renderTimingOffset = "0", bool srgbOutput = false) {
        if (handle || renderer) throw std::runtime_error("Native session is already initialized");
        observed.clear(); actions.clear(); lastError.clear(); lastErrorCode = 0;
        frames = presentedFrames = loadedFiles = restarts = commandErrors = subtitleCommandErrors = subtitleCommandsPending = subtitleCommandReplies = 0; requested.store(false);
        generatedSubtitleCommandErrors = generatedSubtitleCommandsPending = generatedSubtitleCommandReplies = 0;
        generatedTimeline = {}; generatedVisible = generatedFailed = generatedRefreshRequired = false; generatedLastText.clear(); generatedRevision = 0;
        generatedWidth = generatedHeight = 0; osdWidth = osdHeight = osdLeft = osdRight = osdTop = osdBottom = 0;
        renderWakeupContext.store(wakeupContext); renderWakeup.store(wakeup);
        handle = mpv_create();
        if (!handle) throw std::runtime_error("mpv_create failed");
        const char *options[][2] = {
            {"config", "no"}, {"load-scripts", "no"}, {"ytdl", "no"}, {"vo", "libmpv"}, {"hwdec", hardwareDecode},
            {"idle", "yes"}, {"keep-open", "yes"}, {"pause", "yes"}, {"volume", "50"}, {"terminal", "no"},
            {"input-default-bindings", "no"}, {"input-vo-keyboard", "no"}, {"osc", "no"},
            {"audio-pitch-correction", "yes"}, {"sub-auto", "no"}, {"audio-file-auto", "no"},
            {"access-references", "no"}, {"video-timing-offset", renderTimingOffset}
        };
        for (const auto &option : options) {
            int error = mpv_set_option_string(handle, option[0], option[1]);
            if (error < 0) throw std::runtime_error(std::string(option[0]) + ": " + mpv_error_string(error));
        }
        if (srgbOutput) {
            // Only the opt-in macOS Canvas producer uses this display contract.
            // Other native/platform renderers keep their existing color policy.
            const char *display[][2] = {{"target-prim", "bt.709"}, {"target-trc", "srgb"}, {"video-output-levels", "full"}};
            for (const auto &option : display) {
                const int error = mpv_set_option_string(handle, option[0], option[1]);
                if (error < 0) throw std::runtime_error(std::string(option[0]) + ": " + mpv_error_string(error));
            }
        }
        if (softwareRendering) {
            // Mesa llvmpipe/softpipe can misrender libmpv's convolution scaling
            // path (black/striped/partial frames). A conservative supported GL
            // path keeps playback usable on software contexts; real GPUs keep
            // normal quality. See mpv-player/mpv#14577 for the upstream symptom.
            const char *fallback[][2] = {{"scale", "bilinear"}, {"cscale", "bilinear"}, {"dscale", "bilinear"}, {"correct-downscaling", "no"}, {"gpu-dumb-mode", "yes"}};
            for (const auto &option : fallback) {
                int result = mpv_set_option_string(handle, option[0], option[1]);
                if (result < 0) throw std::runtime_error(mpv_error_string(result));
            }
        }
        if (cpuRendering) {
            // libmpv SW defaults to single-threaded Lanczos conversion/scaling.
            // The compatibility path favors timely frames at desktop sizes.
            // A zero render lead makes the SW callback miss presentation
            // deadlines even when conversion is fast. Allow 20ms for rendering
            // and IPC; BLOCK_FOR_TARGET_TIME remains off in the helper.
            const int timing = mpv_set_option_string(handle, "video-timing-offset", "0.02");
            if (timing < 0) throw std::runtime_error(mpv_error_string(timing));
            const int result = mpv_set_option_string(handle, "sws-scaler", "bilinear");
            if (result < 0) throw std::runtime_error(mpv_error_string(result));
            // The SW render API uses legacy sws_scale: RGB conversion alone
            // leaves HDR transfer functions/gamut unchanged. FFmpeg 9's scale
            // filter uses the frame API and its perceptual color mapper, so
            // produce tagged BT.709 SDR before the final viewport conversion.
            // SDR BT.709 remains a no-op; no GL or additional library is needed.
            const int color = mpv_set_option_string(handle, "vf",
                "lavfi=[scale=out_primaries=bt709:out_transfer=bt709:out_color_matrix=bt709:intent=perceptual]");
            if (color < 0) throw std::runtime_error(std::string("CPU SDR conversion: ") + mpv_error_string(color));
        }
        int error = mpv_initialize(handle);
        if (error < 0) throw std::runtime_error(mpv_error_string(error));
        mpv_opengl_init_params gl = {getProc, context};
        mpv_render_param params[] = {{MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL},
            {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        mpv_render_param software[] = {{MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_SW}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        error = mpv_render_context_create(&renderer, handle, cpuRendering ? software : params);
        if (error < 0) throw std::runtime_error(std::string(cpuRendering ? "CPU render context: " : "OpenGL render context: ") + mpv_error_string(error));
        const char *numbers[] = {"time-pos", "duration", "volume", "speed", "width", "height", "audio-pts", "frame-drop-count", "sub-delay", "sub-font-size"};
        const char *strings[] = {"hwdec-current", "video-codec", "audio-codec", "audio-device", "current-ao", "sid", "aid"};
        const char *flags[] = {"pause", "mute", "eof-reached", "core-idle", "seekable", "seeking", "paused-for-cache"};
        for (const char *name : numbers) mpv_observe_property(handle, 0, name, MPV_FORMAT_DOUBLE);
        for (const char *name : strings) mpv_observe_property(handle, 0, name, MPV_FORMAT_STRING);
        for (const char *name : flags) mpv_observe_property(handle, 0, name, MPV_FORMAT_FLAG);
        mpv_observe_property(handle, 0, "track-list", MPV_FORMAT_NODE);
        mpv_observe_property(handle, 0, "chapter-list", MPV_FORMAT_NODE);
        mpv_observe_property(handle, 0, "osd-dimensions", MPV_FORMAT_NODE);
        mpv_render_context_set_update_callback(renderer, request, this);
    }
    void shutdown() {
        renderWakeup.store(nullptr);
        if (handle) mpv_set_wakeup_callback(handle, nullptr, nullptr);
        if (renderer) { mpv_render_context_set_update_callback(renderer, nullptr, nullptr); mpv_render_context_free(renderer); renderer = nullptr; }
        if (handle) { mpv_terminate_destroy(handle); handle = nullptr; }
        actions.clear(); requested.store(false);
        generatedTimeline = {}; generatedVisible = false; generatedLastText.clear();
    }
    void generatedSubtitles(const std::string &operation, const std::string &document, bool visible, uint64_t revision) {
        if (!alive()) throw std::runtime_error("No native playback session");
        if (revision <= generatedRevision) return;
        try {
            if (operation == "update") generatedTimeline = parseGeneratedSubtitles(document);
            else if (operation == "clear") generatedTimeline = {};
            else if (operation != "visible") throw std::runtime_error("Invalid generated subtitle operation");
            generatedVisible = operation != "clear" && visible;
            // A rejected replacement may have left the previous overlay visible.
            // Retry/clear must submit even when the desired text is empty.
            if (generatedFailed) generatedRefreshRequired = true;
            generatedFailed = false;
            refreshGeneratedSubtitles();
        } catch (...) { subtitleCommandErrors++; generatedSubtitleCommandErrors++; }
        generatedRevision = revision;
    }
#ifndef JAVDEX_STANDALONE_PLAYBACK
    void generatedSubtitles(napi_env env, napi_callback_info info) {
        napi_value args[4]; size_t count = 4; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        bool visible = false; double revision = 0;
        if (count != 4 || napi_get_value_bool(env, args[2], &visible) != napi_ok
            || napi_get_value_double(env, args[3], &revision) != napi_ok || !std::isfinite(revision)
            || revision < 1 || revision > 9007199254740991.0 || std::floor(revision) != revision)
            throw std::runtime_error("Invalid generated subtitle update");
        generatedSubtitles(stringArg(env, args[0]), stringArg(env, args[1]), visible, static_cast<uint64_t>(revision));
    }
#endif
#ifndef JAVDEX_STANDALONE_PLAYBACK
    void command(napi_env env, napi_value array, bool generatedSubtitle = false) {
        if (!alive()) throw std::runtime_error("No native playback session");
        bool isArray = false; napi_is_array(env, array, &isArray);
        if (!isArray) throw std::runtime_error("Expected command array");
        uint32_t length = 0; napi_get_array_length(env, array, &length);
        if (!length || length > 8) throw std::runtime_error("Invalid command length");
        std::vector<std::string> values;
        for (uint32_t i = 0; i < length; i++) { napi_value value; napi_get_element(env, array, i, &value); values.push_back(stringArg(env, value)); }
        command(values, generatedSubtitle);
    }
#endif
    void command(const std::vector<std::string> &values, bool generatedSubtitle = false) {
        if (!alive()) throw std::runtime_error("No native playback session");
        if (values.empty() || values.size() > 8) throw std::runtime_error("Invalid command length");
        std::vector<const char *> args;
        for (const auto &value : values) args.push_back(value.c_str());
        args.push_back(nullptr);
        // Never synchronously wait on the mpv client from the platform GL thread.
        const int error = mpv_command_async(handle, optionalSubtitleCommand(values) ? (generatedSubtitle ? 2 : 1) : 0, args.data());
        if (error < 0) throw std::runtime_error(mpv_error_string(error));
        if (optionalSubtitleCommand(values)) subtitleCommandsPending++;
        if (generatedSubtitle && optionalSubtitleCommand(values)) generatedSubtitleCommandsPending++;
        if (values[0] == "loadfile") {
            generatedTimeline = {}; generatedVisible = false;
            if (generatedFailed) generatedRefreshRequired = true;
            generatedFailed = false; refreshGeneratedSubtitles();
        }
    }
    void queue(const char *kind, double value = 0) { if (actions.size() < 32) actions.push_back({kind, value}); }
    bool updateRequested() {
        // Drain into the existing action queue without consuming its ownership.
        // Subtitle timing follows native frame observations, not the 200ms UI poll.
        drainEvents(); refreshGeneratedSubtitles();
        return renderer && requested.exchange(false) && (mpv_render_context_update(renderer) & MPV_RENDER_UPDATE_FRAME);
    }
    // Render API timestamps use mpv's own epoch. Translate the delta into the
    // Linux CLOCK_MONOTONIC domain in the helper, never into wall-clock time.
    int64_t nextFrameDelayUs() {
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 2)
        if (!renderer) return 0;
        mpv_render_frame_info info{};
        mpv_render_param param{MPV_RENDER_PARAM_NEXT_FRAME_INFO, &info};
        if (mpv_render_context_get_info(renderer, param) < 0 || !info.target_time
            || (info.flags & (MPV_RENDER_FRAME_INFO_REDRAW | MPV_RENDER_FRAME_INFO_REPEAT))) return 0;
        // Pinned mpv 0.41 vo_libmpv.c exports vo_frame::pts in nanoseconds,
        // although render.h still documents microseconds. Match the actual
        // bundled implementation; revalidate this contract on mpv upgrades.
        return (info.target_time - mpv_get_time_ns(handle)) / 1000;
#else
        // Older system libmpv is supported for development compilation only.
        // Its clock contract is not the pinned runtime contract tested here.
        return 0;
#endif
    }
    bool render(int width, int height, int framebuffer = 0, bool flipY = true) {
        if (!renderer || width <= 0 || height <= 0) return false;
        generatedWidth = width; generatedHeight = height;
        drainEvents(); refreshGeneratedSubtitles();
        mpv_render_context_update(renderer);
        mpv_opengl_fbo fbo = {framebuffer, width, height, 0}; int flip = flipY ? 1 : 0, block = 0;
        mpv_render_param params[] = {{MPV_RENDER_PARAM_OPENGL_FBO, &fbo}, {MPV_RENDER_PARAM_FLIP_Y, &flip},
            {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        const int error = mpv_render_context_render(renderer, params);
        if (error < 0) { lastErrorCode = error; lastError = mpv_error_string(error); return false; }
        frames++;
        return true;
    }
    bool renderSoftware(int width, int height, size_t stride, void *pixels) {
        if (!renderer || width <= 0 || height <= 0) return false;
        generatedWidth = width; generatedHeight = height;
        drainEvents(); refreshGeneratedSubtitles(); mpv_render_context_update(renderer);
        int dimensions[] = {width, height}, block = 0;
        mpv_render_param params[] = {{MPV_RENDER_PARAM_SW_SIZE, dimensions},
            {MPV_RENDER_PARAM_SW_FORMAT, (void *)"rgb0"}, {MPV_RENDER_PARAM_SW_STRIDE, &stride},
            {MPV_RENDER_PARAM_SW_POINTER, pixels}, {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block},
            {MPV_RENDER_PARAM_INVALID, nullptr}};
        const int error = mpv_render_context_render(renderer, params);
        if (error < 0) { lastErrorCode = error; lastError = mpv_error_string(error); return false; }
        frames++; return true;
    }
    bool skipRender() {
        if (!renderer) return false;
        // Hidden shared-texture surfaces must still consume frame updates so
        // video does not stall audio. No render target or frame ownership is
        // involved, and skipped frames are not counted as rendered/presented.
        int skip = 1, block = 0;
        mpv_render_param params[] = {{MPV_RENDER_PARAM_SKIP_RENDERING, &skip},
            {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        const int error = mpv_render_context_render(renderer, params);
        if (error < 0) { lastErrorCode = error; lastError = mpv_error_string(error); return false; }
        return true;
    }
    // Optional native swapchain feedback only. Shared-frame IPC publication,
    // skipped rendering and consumer resource release are not display swaps.
    void swapped() { if (renderer) mpv_render_context_report_swap(renderer); }
    void presented(bool visible) { if (visible && loadedFiles > 0) presentedFrames++; }
    void consume(const mpv_event &event) {
        if (event.event_id == MPV_EVENT_COMMAND_REPLY && (event.reply_userdata == 1 || event.reply_userdata == 2)) {
            if (subtitleCommandsPending) subtitleCommandsPending--;
            subtitleCommandReplies++;
            if (event.reply_userdata == 2) {
                if (generatedSubtitleCommandsPending) generatedSubtitleCommandsPending--;
                generatedSubtitleCommandReplies++;
            }
        }
        if (event.event_id == MPV_EVENT_PROPERTY_CHANGE) {
            const auto *property = static_cast<mpv_event_property *>(event.data);
            if (std::string(property->name) == "osd-dimensions" && property->format == MPV_FORMAT_NODE && property->data) {
                const auto &node = *static_cast<mpv_node *>(property->data);
                if (node.format == MPV_FORMAT_NODE_MAP && node.u.list) for (int i = 0; i < node.u.list->num; i++) {
                    const std::string key = node.u.list->keys[i]; const auto &entry = node.u.list->values[i];
                    const double value = entry.format == MPV_FORMAT_INT64 ? static_cast<double>(entry.u.int64)
                        : entry.format == MPV_FORMAT_DOUBLE ? entry.u.double_ : 0;
                    if (!std::isfinite(value)) continue;
                    if (key == "w") osdWidth = value; else if (key == "h") osdHeight = value;
                    else if (key == "ml") osdLeft = value; else if (key == "mr") osdRight = value;
                    else if (key == "mt") osdTop = value; else if (key == "mb") osdBottom = value;
                }
                return;
            }
            ObservedValue value; value.format = property->format;
            if (property->data) {
                if (property->format == MPV_FORMAT_DOUBLE) value.number = *static_cast<double *>(property->data);
                if (property->format == MPV_FORMAT_FLAG) value.number = *static_cast<int *>(property->data);
                if (property->format == MPV_FORMAT_STRING) { const char *text = *static_cast<char **>(property->data); value.text = text ? text : ""; }
                if (property->format == MPV_FORMAT_NODE) value.text = nodeJson(*static_cast<mpv_node *>(property->data));
            }
            observed[property->name] = std::move(value);
        }
        if (event.event_id == MPV_EVENT_FILE_LOADED) loadedFiles++;
        if (event.event_id == MPV_EVENT_START_FILE) {
            generatedTimeline = {}; generatedVisible = false;
            if (generatedFailed) generatedRefreshRequired = true;
            generatedFailed = false;
        }
        if (event.event_id == MPV_EVENT_PLAYBACK_RESTART) restarts++;
        int error = event.event_id == MPV_EVENT_COMMAND_REPLY ? event.error : event.event_id == MPV_EVENT_END_FILE ? static_cast<mpv_event_end_file *>(event.data)->error : 0;
        if (error < 0) {
            if (event.event_id == MPV_EVENT_COMMAND_REPLY) {
                commandErrors++;
                // Optional track/display failures must not destroy the video session.
                if (event.reply_userdata == 1 || event.reply_userdata == 2) {
                    subtitleCommandErrors++;
                    if (event.reply_userdata == 2) { generatedSubtitleCommandErrors++; generatedFailed = true; }
                    return;
                }
            }
            lastErrorCode = error; lastError = mpv_error_string(error);
        }
    }
    const char *errorKind() const {
        switch (lastErrorCode) {
            case MPV_ERROR_UNKNOWN_FORMAT: return "format";
            case MPV_ERROR_NOTHING_TO_PLAY: return "streams";
            case MPV_ERROR_AO_INIT_FAILED: return "audio";
            case MPV_ERROR_VO_INIT_FAILED: return "video";
            case MPV_ERROR_LOADING_FAILED: return "load";
            default: return "native";
        }
    }
    void drainEvents() {
        if (!alive()) return;
        while (true) { const auto *event = mpv_wait_event(handle, 0); if (event->event_id == MPV_EVENT_NONE) break; consume(*event); }
    }
    std::string stateJson() {
        drainEvents();
        std::string result = std::string("{\"alive\":") + (alive() ? "true" : "false");
        auto number = [&](const char *key, double value) {
            std::ostringstream text; text.imbue(std::locale::classic()); text << std::setprecision(17) << value;
            result += ',' + jsonString(key) + ':' + (std::isfinite(value) ? text.str() : "null");
        };
        for (const auto &[key, value] : observed) {
            if (value.format == MPV_FORMAT_DOUBLE) number(key.c_str(), value.number);
            if (value.format == MPV_FORMAT_FLAG) result += ',' + jsonString(key.c_str()) + ':' + (value.number ? "true" : "false");
            if (value.format == MPV_FORMAT_STRING || value.format == MPV_FORMAT_NODE) result += ',' + jsonString(key.c_str()) + ':' + jsonString(value.text.c_str());
        }
        number("nativeFrames", frames); number("presentedFrames", presentedFrames); number("loadedFiles", loadedFiles);
        number("playbackRestarts", restarts); number("commandErrors", commandErrors);
        number("subtitleCommandErrors", subtitleCommandErrors);
        number("generatedSubtitleCommandErrors", generatedSubtitleCommandErrors);
        number("generatedSubtitleCommandsPending", generatedSubtitleCommandsPending);
        number("generatedSubtitleCommandReplies", generatedSubtitleCommandReplies);
        number("generatedSubtitleOverlayVersion", 1); number("generatedSubtitleRevision", generatedRevision);
        number("subtitleCommandsPending", subtitleCommandsPending);
        number("subtitleCommandReplies", subtitleCommandReplies);
        result += ",\"errorKind\":" + jsonString(errorKind()) + ",\"error\":" + jsonString(lastError.c_str()) + ",\"actions\":[";
        for (size_t i = 0; i < actions.size(); i++) {
            if (i) result += ',';
            result += "{\"kind\":" + jsonString(actions[i].kind.c_str()) + ",\"value\":" + std::to_string(actions[i].value) + '}';
        }
        actions.clear();
        return result + "]}";
    }
#ifndef JAVDEX_STANDALONE_PLAYBACK
    napi_value state(napi_env env, bool drain) {
        napi_value result; napi_create_object(env, &result);
        setFlag(env, result, "alive", alive());
        if (!alive()) return result;
        if (drain) while (true) { const auto *event = mpv_wait_event(handle, 0); if (event->event_id == MPV_EVENT_NONE) break; consume(*event); }
        for (const auto &[key, value] : observed) {
            if (value.format == MPV_FORMAT_DOUBLE) setNumber(env, result, key.c_str(), value.number);
            if (value.format == MPV_FORMAT_FLAG) setFlag(env, result, key.c_str(), value.number != 0);
            if (value.format == MPV_FORMAT_STRING || value.format == MPV_FORMAT_NODE) setString(env, result, key.c_str(), value.text);
        }
        if (drain) {
            napi_value pending; napi_create_array(env, &pending); uint32_t index = 0;
            for (const auto &action : actions) { napi_value item; napi_create_object(env, &item); setString(env, item, "kind", action.kind); setNumber(env, item, "value", action.value); napi_set_element(env, pending, index++, item); }
            actions.clear(); napi_set_named_property(env, result, "actions", pending);
        }
        setNumber(env, result, "nativeFrames", frames); setNumber(env, result, "presentedFrames", presentedFrames);
        setNumber(env, result, "loadedFiles", loadedFiles); setNumber(env, result, "playbackRestarts", restarts); setNumber(env, result, "commandErrors", commandErrors);
        setNumber(env, result, "subtitleCommandsPending", subtitleCommandsPending);
        setNumber(env, result, "subtitleCommandReplies", subtitleCommandReplies);
        setNumber(env, result, "generatedSubtitleCommandErrors", generatedSubtitleCommandErrors);
        setNumber(env, result, "generatedSubtitleCommandsPending", generatedSubtitleCommandsPending);
        setNumber(env, result, "generatedSubtitleCommandReplies", generatedSubtitleCommandReplies);
        setNumber(env, result, "generatedSubtitleOverlayVersion", 1); setNumber(env, result, "generatedSubtitleRevision", generatedRevision);
        setNumber(env, result, "subtitleCommandErrors", subtitleCommandErrors);
        setString(env, result, "error", lastError);
        if (lastErrorCode < 0) setString(env, result, "errorKind", errorKind());
        return result;
    }
#endif
};
}
