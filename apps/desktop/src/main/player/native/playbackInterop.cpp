// Main-process resource import only. Deliberately no libmpv, GL or D3D link.
// Producer fences and consumer release remain owned by their respective hosts.
#include <node_api.h>
#include <cstdint>
#include <cmath>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include "macSurfaceTransport.h"
#endif
namespace {
std::set<uintptr_t> owned;
napi_value empty(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
napi_value error(napi_env env, const char *text) { napi_throw_error(env, nullptr, text); return nullptr; }
uintptr_t pointer(napi_env env, napi_value v) {
    bool buffer = false; void *p = nullptr; size_t size = 0;
    napi_is_buffer(env, v, &buffer);
    if (!buffer || napi_get_buffer_info(env, v, &p, &size) != napi_ok || size != sizeof(uintptr_t)) throw std::runtime_error("Invalid playback resource");
    uintptr_t result; std::memcpy(&result, p, sizeof(result)); return result;
}
napi_value buffer(napi_env env, uintptr_t pointer) {
    napi_value value;
    if (napi_create_buffer_copy(env, sizeof(pointer), &pointer, nullptr, &value) != napi_ok) throw std::runtime_error("Cannot encode playback resource");
    return value;
}
void dispose(uintptr_t value) {
#ifdef _WIN32
    CloseHandle(reinterpret_cast<HANDLE>(value));
#else
    CFRelease(reinterpret_cast<IOSurfaceRef>(value));
#endif
}
napi_value release(napi_env env, napi_callback_info info) {
    try {
        napi_value args[1]; size_t count = 1; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("Expected playback resource");
        const auto value = pointer(env, args[0]);
        if (owned.erase(value)) dispose(value);
        return empty(env);
    } catch (const std::exception &e) { return error(env, e.what()); }
}
#ifdef _WIN32
napi_value acquire(napi_env env, napi_callback_info info) {
    HANDLE process = nullptr, duplicate = nullptr;
    try {
        napi_value args[2]; size_t count = 2; uint32_t pid = 0;
        napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 2 || napi_get_value_uint32(env, args[1], &pid) != napi_ok || !pid || owned.size() >= 12)
            throw std::runtime_error("Invalid playback host resource");
        const auto original = reinterpret_cast<HANDLE>(pointer(env, args[0]));
        process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, pid);
        if (!process || !DuplicateHandle(process, original, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS))
            throw std::runtime_error("Cannot import playback host shared handle");
        CloseHandle(process); process = nullptr;
        const auto value = reinterpret_cast<uintptr_t>(duplicate);
        auto result = buffer(env, value); owned.insert(value); return result;
    } catch (const std::exception &e) {
        if (duplicate) CloseHandle(duplicate); if (process) CloseHandle(process); return error(env, e.what());
    }
}
#else
std::string string(napi_env env, napi_value value) {
    size_t size = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok || size > 120) throw std::runtime_error("Invalid playback channel");
    std::vector<char> bytes(size + 1); napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &size);
    std::string result(bytes.data(), size);
    if (result.find("org.javdex.playback.") != 0 || result.size() < 50) throw std::runtime_error("Invalid playback channel");
    return result;
}
javdex::mac::SurfaceChannels channels;
napi_value createChannel(napi_env env, napi_callback_info info) {
    try {
        napi_value args[1]; size_t count = 1; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("Expected playback channel");
        channels.open(string(env, args[0])); return empty(env);
    } catch (const std::exception &e) { return error(env, e.what()); }
}
napi_value closeChannel(napi_env env, napi_callback_info info) {
    try {
        napi_value args[1]; size_t count = 1; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("Expected playback channel");
        channels.close(string(env, args[0])); return empty(env);
    } catch (const std::exception &e) { return error(env, e.what()); }
}
napi_value publishSurface(napi_env env, napi_callback_info info) {
    try {
        napi_value args[3]; size_t count = 3; double sequence = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 3 || napi_get_value_double(env, args[1], &sequence) != napi_ok || sequence < 1 || sequence > 9007199254740991.0 || std::floor(sequence) != sequence)
            throw std::runtime_error("Invalid playback surface sequence");
        javdex::mac::SurfaceChannels::publish(string(env, args[0]), static_cast<uint64_t>(sequence), reinterpret_cast<IOSurfaceRef>(pointer(env, args[2])));
        return empty(env);
    } catch (const std::exception &e) { return error(env, e.what()); }
}
napi_value acquireSurface(napi_env env, napi_callback_info info) {
    IOSurfaceRef surface = nullptr;
    try {
        napi_value args[2]; size_t count = 2; double sequence = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 2 || napi_get_value_double(env, args[1], &sequence) != napi_ok || sequence < 1 || sequence > 9007199254740991.0 || std::floor(sequence) != sequence || owned.size() >= 12)
            throw std::runtime_error("Invalid playback surface");
        surface = channels.acquire(string(env, args[0]), static_cast<uint64_t>(sequence));
        const auto value = reinterpret_cast<uintptr_t>(surface); auto result = buffer(env, value);
        owned.insert(value); return result;
    } catch (const std::exception &e) { if (surface) CFRelease(surface); return error(env, e.what()); }
}
#endif
napi_value initialize(napi_env env, napi_value exports) {
    const napi_property_descriptor properties[] = {
        {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef _WIN32
        {"acquire", nullptr, acquire, nullptr, nullptr, nullptr, napi_default, nullptr}
#else
        {"createChannel", nullptr, createChannel, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"closeChannel", nullptr, closeChannel, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"publishSurface", nullptr, publishSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"acquireSurface", nullptr, acquireSurface, nullptr, nullptr, nullptr, napi_default, nullptr}
#endif
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties); return exports;
}
}
NAPI_MODULE(playback_interop, initialize)
