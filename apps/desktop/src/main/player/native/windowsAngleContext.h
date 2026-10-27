#pragma once
// EGL is loaded only in the isolated playback process, from the private
// playback runtime. Electron 44 statically links its own consumer-side ANGLE.
#include <windows.h>
#include <d3d11.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <stdexcept>
#include <string>

namespace javdex {
class WindowsAngleContext {
    HMODULE egl = nullptr, gles = nullptr;
    EGLDeviceEXT device = EGL_NO_DEVICE_EXT;
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    EGLConfig config = nullptr;
    PFNEGLGETPROCADDRESSPROC getProc = nullptr;
    PFNEGLMAKECURRENTPROC makeCurrent = nullptr;
    PFNEGLDESTROYSURFACEPROC destroySurface = nullptr;
    PFNEGLDESTROYCONTEXTPROC destroyContext = nullptr;
    PFNEGLTERMINATEPROC terminate = nullptr;
    PFNEGLRELEASEDEVICEANGLEPROC releaseDevice = nullptr;
    PFNEGLCREATEPBUFFERFROMCLIENTBUFFERPROC createBuffer = nullptr;
    template<class T> T entry(const char *name) {
        auto address = GetProcAddress(egl, name);
        if (!address && getProc) address = reinterpret_cast<FARPROC>(getProc(name));
        if (!address) throw std::runtime_error(std::string("Missing ANGLE entry: ") + name);
        return reinterpret_cast<T>(address);
    }
    static HMODULE library(const wchar_t *name) {
        wchar_t executable[32768]{};
        HMODULE module = nullptr;
        if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&library), &module)) throw std::runtime_error("Cannot locate playback module");
        const DWORD length = GetModuleFileNameW(module, executable, 32768);
        if (!length || length >= 32768) throw std::runtime_error("Cannot locate private playback ANGLE");
        std::wstring path(executable, length);
        path = path.substr(0, path.find_last_of(L"\\/") + 1) + name;
        // A module with the same basename from another directory must not be
        // silently reused by mpv's dynamic ANGLE loader.
        if (auto existing = GetModuleHandleW(name)) {
            wchar_t loaded[32768]{};
            const auto loadedLength = GetModuleFileNameW(existing, loaded, 32768);
            if (!loadedLength || loadedLength >= 32768 || _wcsicmp(path.c_str(), loaded))
                throw std::runtime_error("A different ANGLE library is already loaded");
        }
        auto result = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (!result) throw std::runtime_error("Private playback ANGLE library is unavailable");
        return result;
    }
public:
    WindowsAngleContext() = default;
    WindowsAngleContext(const WindowsAngleContext &) = delete;
    WindowsAngleContext &operator=(const WindowsAngleContext &) = delete;
    ~WindowsAngleContext() { close(); }
    bool active() const { return context != EGL_NO_CONTEXT; }
    void *proc(const char *name) const {
        auto address = reinterpret_cast<void *>(GetProcAddress(gles, name));
        return address ? address : reinterpret_cast<void *>(getProc(name));
    }
    void initialize(ID3D11Device *native) {
        egl = library(L"libEGL.dll"); gles = library(L"libGLESv2.dll");
        getProc = entry<PFNEGLGETPROCADDRESSPROC>("eglGetProcAddress");
        makeCurrent = entry<PFNEGLMAKECURRENTPROC>("eglMakeCurrent");
        destroySurface = entry<PFNEGLDESTROYSURFACEPROC>("eglDestroySurface");
        destroyContext = entry<PFNEGLDESTROYCONTEXTPROC>("eglDestroyContext");
        terminate = entry<PFNEGLTERMINATEPROC>("eglTerminate");
        releaseDevice = entry<PFNEGLRELEASEDEVICEANGLEPROC>("eglReleaseDeviceANGLE");
        createBuffer = entry<PFNEGLCREATEPBUFFERFROMCLIENTBUFFERPROC>("eglCreatePbufferFromClientBuffer");
        const auto query = entry<PFNEGLQUERYSTRINGPROC>("eglQueryString");
        const std::string client = query(EGL_NO_DISPLAY, EGL_EXTENSIONS) ? query(EGL_NO_DISPLAY, EGL_EXTENSIONS) : "";
        if (client.find("EGL_ANGLE_device_creation_d3d11") == std::string::npos)
            throw std::runtime_error("ANGLE cannot use the hardware D3D11 device");
        const auto createDevice = entry<PFNEGLCREATEDEVICEANGLEPROC>("eglCreateDeviceANGLE");
        device = createDevice(EGL_D3D11_DEVICE_ANGLE, native, nullptr);
        if (device == EGL_NO_DEVICE_EXT) throw std::runtime_error("Cannot create ANGLE D3D11 device");
        display = entry<PFNEGLGETPLATFORMDISPLAYEXTPROC>("eglGetPlatformDisplayEXT")(EGL_PLATFORM_DEVICE_EXT, device, nullptr);
        if (display == EGL_NO_DISPLAY || !entry<PFNEGLINITIALIZEPROC>("eglInitialize")(display, nullptr, nullptr))
            throw std::runtime_error("Cannot initialize ANGLE hardware display");
        const std::string extensions = query(display, EGL_EXTENSIONS) ? query(display, EGL_EXTENSIONS) : "";
        if (extensions.find("EGL_ANGLE_d3d_texture_client_buffer") == std::string::npos
            || extensions.find("EGL_ANGLE_stream_producer_d3d_texture") == std::string::npos)
            throw std::runtime_error("ANGLE D3D11 texture interop is unavailable");
        const EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
            EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
        EGLint count = 0;
        if (!entry<PFNEGLCHOOSECONFIGPROC>("eglChooseConfig")(display, attributes, &config, 1, &count) || count != 1
            || !entry<PFNEGLBINDAPIPROC>("eglBindAPI")(EGL_OPENGL_ES_API))
            throw std::runtime_error("Cannot configure ANGLE GLES3 output");
        const EGLint version[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
        context = entry<PFNEGLCREATECONTEXTPROC>("eglCreateContext")(display, config, EGL_NO_CONTEXT, version);
        if (context == EGL_NO_CONTEXT) throw std::runtime_error("Cannot create ANGLE GLES3 context");
    }
    void current(EGLSurface target = EGL_NO_SURFACE) {
        // The private control pbuffer is used for mpv updates/teardown. Never
        // make an exported, consumer-owned output current for those operations.
        if (target == EGL_NO_SURFACE) target = surface;
        if (!makeCurrent(display, target, target, context)) throw std::runtime_error("Cannot activate ANGLE output");
    }
    void unbind() {
        if (!makeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT))
            throw std::runtime_error("Cannot release ANGLE output");
    }
    void clearSurface() {
        if (display != EGL_NO_DISPLAY && makeCurrent) {
            unbind();
            if (surface != EGL_NO_SURFACE && !destroySurface(display, surface))
                throw std::runtime_error("Cannot destroy ANGLE output surface");
        }
        surface = EGL_NO_SURFACE;
    }
    void bindTexture(ID3D11Texture2D *texture) {
        clearSurface();
        surface = createTextureSurface(texture);
        current();
    }
    EGLSurface createTextureSurface(ID3D11Texture2D *texture) {
        const EGLint attributes[] = {EGL_NONE};
        const auto target = createBuffer(display, EGL_D3D_TEXTURE_ANGLE, texture, config, attributes);
        if (target == EGL_NO_SURFACE) throw std::runtime_error("Cannot bind D3D11 texture to ANGLE");
        return target;
    }
    void destroyTextureSurface(EGLSurface &target) {
        if (target != EGL_NO_SURFACE && !destroySurface(display, target))
            throw std::runtime_error("Cannot retire ANGLE output surface");
        target = EGL_NO_SURFACE;
    }
    bool close() noexcept {
        bool completed = true;
        if (display != EGL_NO_DISPLAY) {
            if (makeCurrent && !makeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT)) completed = false;
            if (surface != EGL_NO_SURFACE && destroySurface && !destroySurface(display, surface)) completed = false;
            if (context != EGL_NO_CONTEXT && destroyContext && !destroyContext(display, context)) completed = false;
            if (terminate && !terminate(display)) completed = false;
        }
        surface = EGL_NO_SURFACE; context = EGL_NO_CONTEXT; display = EGL_NO_DISPLAY;
        if (device != EGL_NO_DEVICE_EXT && releaseDevice && !releaseDevice(device)) completed = false;
        device = EGL_NO_DEVICE_EXT;
        // Keep DLLs mapped until process exit: libmpv caches EGL entry points.
        // The isolated process bounds their lifetime, including failed probes.
        return completed;
    }
};
}
