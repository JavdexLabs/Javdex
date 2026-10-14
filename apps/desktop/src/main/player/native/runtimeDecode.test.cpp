// Distribution smoke: dynamically load the relocated libmpv, decode PCM WAV,
// and require EOF (not merely successful library loading). No display/audio device.
#include <mpv/client.h>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

int main(int argc, char** argv) {
    if (argc != 3) return 2;
    try {
#ifdef _WIN32
        SetDllDirectoryA("");
        auto library = LoadLibraryExA(argv[1], nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        auto symbol = [&](const char* name) { return reinterpret_cast<void*>(GetProcAddress(library, name)); };
#else
        auto library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
        auto symbol = [&](const char* name) { return dlsym(library, name); };
#endif
        if (!library) throw std::runtime_error("Cannot load relocated libmpv");
#define API(name) auto name = reinterpret_cast<decltype(&::name)>(symbol(#name)); if (!name) throw std::runtime_error(#name)
        API(mpv_create); API(mpv_set_option_string); API(mpv_initialize);
        API(mpv_command); API(mpv_wait_event); API(mpv_terminate_destroy);
        // One second of mono 8kHz silence, little-endian PCM16.
        std::ofstream wave(argv[2], std::ios::binary);
        auto u32 = [&](unsigned value) { for (int i = 0; i < 4; i++) wave.put(static_cast<char>(value >> (8 * i))); };
        auto u16 = [&](unsigned value) { wave.put(static_cast<char>(value)); wave.put(static_cast<char>(value >> 8)); };
        wave.write("RIFF", 4); u32(16036); wave.write("WAVEfmt ", 8); u32(16);
        u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16);
        wave.write("data", 4); u32(16000); for (int i = 0; i < 16000; i++) wave.put(0); wave.close();
        auto handle = mpv_create(); if (!handle) throw std::runtime_error("mpv_create");
        for (const auto* option : {"config", "load-scripts", "ytdl", "osc", "terminal", "access-references"})
            if (mpv_set_option_string(handle, option, "no") < 0) throw std::runtime_error(option);
        for (const auto* option : {"ao", "vo"})
            if (mpv_set_option_string(handle, option, "null") < 0) throw std::runtime_error(option);
        if (mpv_initialize(handle) < 0) throw std::runtime_error("mpv_initialize");
        const char* command[] = {"loadfile", argv[2], nullptr};
        if (mpv_command(handle, command) < 0) throw std::runtime_error("loadfile");
        bool loaded = false, eof = false;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (std::chrono::steady_clock::now() < deadline && !eof) {
            auto event = mpv_wait_event(handle, 0.1);
            if (event->event_id == MPV_EVENT_FILE_LOADED) loaded = true;
            if (event->event_id == MPV_EVENT_END_FILE) {
                const auto* end = static_cast<mpv_event_end_file*>(event->data);
                if (!end || end->reason != MPV_END_FILE_REASON_EOF || end->error < 0)
                    throw std::runtime_error("Decode did not reach clean EOF");
                eof = true;
            }
        }
        mpv_terminate_destroy(handle);
        if (!loaded || !eof) throw std::runtime_error("No decoded media EOF");
        std::puts("Relocated libmpv PCM decode reached EOF");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what()); return 1;
    }
}
