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

class MpvCore {
    mpv_handle *handle = nullptr;
    mpv_render_context *renderer = nullptr;
    std::atomic<bool> requested{false};
    std::map<std::string, ObservedValue> observed;
    std::deque<NativeAction> actions;
    std::string lastError;
    int lastErrorCode = 0;
    uint64_t frames = 0, presentedFrames = 0, loadedFiles = 0, restarts = 0, commandErrors = 0;
    static void request(void *context) { static_cast<MpvCore *>(context)->requested.store(true); }
public:
    bool alive() const { return handle && renderer; }
    uint64_t loads() const { return loadedFiles; }
    double number(const char *name) const {
        const auto found = observed.find(name);
        return found == observed.end() || !std::isfinite(found->second.number) ? 0 : found->second.number;
    }
    void initialize(void *(*getProc)(void *, const char *), void *context = nullptr, bool softwareRendering = false) {
        if (handle || renderer) throw std::runtime_error("Native session is already initialized");
        observed.clear(); actions.clear(); lastError.clear(); lastErrorCode = 0;
        frames = presentedFrames = loadedFiles = restarts = commandErrors = 0; requested.store(false);
        handle = mpv_create();
        if (!handle) throw std::runtime_error("mpv_create failed");
        const char *options[][2] = {
            {"config", "no"}, {"load-scripts", "no"}, {"ytdl", "no"}, {"vo", "libmpv"}, {"hwdec", "auto"},
            {"idle", "yes"}, {"keep-open", "yes"}, {"pause", "yes"}, {"volume", "50"}, {"terminal", "no"},
            {"input-default-bindings", "no"}, {"input-vo-keyboard", "no"}, {"osc", "no"},
            {"audio-pitch-correction", "yes"}, {"sub-auto", "no"}, {"audio-file-auto", "no"},
            {"access-references", "no"}, {"video-timing-offset", "0"}
        };
        for (const auto &option : options) {
            int error = mpv_set_option_string(handle, option[0], option[1]);
            if (error < 0) throw std::runtime_error(std::string(option[0]) + ": " + mpv_error_string(error));
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
        int error = mpv_initialize(handle);
        if (error < 0) throw std::runtime_error(mpv_error_string(error));
        mpv_opengl_init_params gl = {getProc, context};
        mpv_render_param params[] = {{MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL},
            {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        error = mpv_render_context_create(&renderer, handle, params);
        if (error < 0) throw std::runtime_error(mpv_error_string(error));
        const char *numbers[] = {"time-pos", "duration", "volume", "speed", "width", "height", "audio-pts", "frame-drop-count", "sub-delay", "sub-font-size"};
        const char *strings[] = {"hwdec-current", "video-codec", "audio-codec", "audio-device", "current-ao"};
        const char *flags[] = {"pause", "mute", "eof-reached", "core-idle", "seekable", "seeking", "paused-for-cache"};
        for (const char *name : numbers) mpv_observe_property(handle, 0, name, MPV_FORMAT_DOUBLE);
        for (const char *name : strings) mpv_observe_property(handle, 0, name, MPV_FORMAT_STRING);
        for (const char *name : flags) mpv_observe_property(handle, 0, name, MPV_FORMAT_FLAG);
        mpv_observe_property(handle, 0, "track-list", MPV_FORMAT_NODE);
        mpv_observe_property(handle, 0, "chapter-list", MPV_FORMAT_NODE);
        mpv_render_context_set_update_callback(renderer, request, this);
    }
    void shutdown() {
        if (renderer) { mpv_render_context_set_update_callback(renderer, nullptr, nullptr); mpv_render_context_free(renderer); renderer = nullptr; }
        if (handle) { mpv_terminate_destroy(handle); handle = nullptr; }
        actions.clear(); requested.store(false);
    }
#ifndef JAVDEX_STANDALONE_PLAYBACK
    void command(napi_env env, napi_value array) {
        if (!alive()) throw std::runtime_error("No native playback session");
        bool isArray = false; napi_is_array(env, array, &isArray);
        if (!isArray) throw std::runtime_error("Expected command array");
        uint32_t length = 0; napi_get_array_length(env, array, &length);
        if (!length || length > 8) throw std::runtime_error("Invalid command length");
        std::vector<std::string> values;
        for (uint32_t i = 0; i < length; i++) { napi_value value; napi_get_element(env, array, i, &value); values.push_back(stringArg(env, value)); }
        command(values);
    }
#endif
    void command(const std::vector<std::string> &values) {
        if (!alive()) throw std::runtime_error("No native playback session");
        if (values.empty() || values.size() > 8) throw std::runtime_error("Invalid command length");
        std::vector<const char *> args;
        for (const auto &value : values) args.push_back(value.c_str());
        args.push_back(nullptr);
        // Never synchronously wait on the mpv client from the platform GL thread.
        const int error = mpv_command_async(handle, 0, args.data());
        if (error < 0) throw std::runtime_error(mpv_error_string(error));
    }
    void queue(const char *kind, double value = 0) { if (actions.size() < 32) actions.push_back({kind, value}); }
    bool updateRequested() { return renderer && requested.exchange(false) && (mpv_render_context_update(renderer) & MPV_RENDER_UPDATE_FRAME); }
    bool render(int width, int height) {
        if (!renderer || width <= 0 || height <= 0) return false;
        mpv_render_context_update(renderer);
        mpv_opengl_fbo fbo = {0, width, height, 0}; int flip = 1, block = 0;
        mpv_render_param params[] = {{MPV_RENDER_PARAM_OPENGL_FBO, &fbo}, {MPV_RENDER_PARAM_FLIP_Y, &flip},
            {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        const int error = mpv_render_context_render(renderer, params);
        if (error < 0) { lastErrorCode = error; lastError = mpv_error_string(error); return false; }
        frames++;
        return true;
    }
    void swapped() { if (renderer) mpv_render_context_report_swap(renderer); }
    void presented(bool visible) { if (visible && loadedFiles > 0) presentedFrames++; }
    void consume(const mpv_event &event) {
        if (event.event_id == MPV_EVENT_PROPERTY_CHANGE) {
            const auto *property = static_cast<mpv_event_property *>(event.data);
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
        if (event.event_id == MPV_EVENT_PLAYBACK_RESTART) restarts++;
        int error = event.event_id == MPV_EVENT_COMMAND_REPLY ? event.error : event.event_id == MPV_EVENT_END_FILE ? static_cast<mpv_event_end_file *>(event.data)->error : 0;
        if (error < 0) {
            if (event.event_id == MPV_EVENT_COMMAND_REPLY) commandErrors++;
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
        setString(env, result, "error", lastError);
        if (lastErrorCode < 0) setString(env, result, "errorKind", errorKind());
        return result;
    }
#endif
};
}
