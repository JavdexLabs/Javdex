// Main-process Windows producer. No HWND is embedded in the player page.
// WGL renders into a PRIVATE D3D11 bridge; copy/query completes before export.
// Electron duplicates our NT handle and transports it, not its numeric bytes.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <GL/gl.h>
#include <uv.h>
#include "mpvCore.h"
#include "frameTiming.h"
#include "windowsTextureTickets.h"
#include <memory>
#include <mutex>
#include <chrono>
#include <cstring>
#include <cmath>

namespace {
using namespace javdex;
template<class T> struct Com {
    T *value = nullptr;
    ~Com() { reset(); }
    void reset() { if (value) { value->Release(); value = nullptr; } }
    T *operator->() const { return value; }
    T **put() { reset(); return &value; }
};
void checked(HRESULT result, const char *operation) {
    if (FAILED(result)) throw std::runtime_error(std::string(operation) + " HRESULT=" + std::to_string(static_cast<unsigned long>(result)));
}
void *proc(const char *name) {
    auto address = wglGetProcAddress(name);
    if (!address || address == reinterpret_cast<PROC>(1) || address == reinterpret_cast<PROC>(2)
        || address == reinterpret_cast<PROC>(3) || address == reinterpret_cast<PROC>(-1))
        address = GetProcAddress(GetModuleHandleW(L"opengl32.dll"), name);
    return reinterpret_cast<void *>(address);
}
template<class T> T load(const char *name) {
    auto result = reinterpret_cast<T>(proc(name));
    if (!result) throw std::runtime_error(std::string("Missing Windows GL entry: ") + name);
    return result;
}
void *mpvProc(void *, const char *name) { return proc(name); }
constexpr GLenum framebuffer = 0x8D40, renderbuffer = 0x8D41, attachment = 0x8CE0, complete = 0x8CD5;
struct Gl {
    void (APIENTRY *genRenderbuffers)(GLsizei, GLuint *) = nullptr;
    void (APIENTRY *deleteRenderbuffers)(GLsizei, const GLuint *) = nullptr;
    void (APIENTRY *bindRenderbuffer)(GLenum, GLuint) = nullptr;
    void (APIENTRY *genFrames)(GLsizei, GLuint *) = nullptr;
    void (APIENTRY *deleteFrames)(GLsizei, const GLuint *) = nullptr;
    void (APIENTRY *bindFrame)(GLenum, GLuint) = nullptr;
    void (APIENTRY *attach)(GLenum, GLenum, GLenum, GLuint) = nullptr;
    GLenum (APIENTRY *status)(GLenum) = nullptr;
    HANDLE (WINAPI *open)(void *) = nullptr;
    BOOL (WINAPI *close)(HANDLE) = nullptr;
    HANDLE (WINAPI *registerObject)(HANDLE, void *, GLuint, GLenum, GLenum) = nullptr;
    BOOL (WINAPI *unregisterObject)(HANDLE, HANDLE) = nullptr;
    BOOL (WINAPI *lock)(HANDLE, GLint, HANDLE *) = nullptr;
    BOOL (WINAPI *unlock)(HANDLE, GLint, HANDLE *) = nullptr;
    void initialize(HDC dc) {
        auto extensions = load<const char *(WINAPI *)(HDC)>("wglGetExtensionsStringARB")(dc);
        const auto has = [&](const char *extension) {
            const std::string padded = std::string(" ") + (extensions ? extensions : "") + " ";
            return padded.find(std::string(" ") + extension + " ") != std::string::npos;
        };
        if (!has("WGL_NV_DX_interop") || !has("WGL_NV_DX_interop2")) throw std::runtime_error("WGL_NV_DX_interop2 is unavailable");
        genRenderbuffers = load<decltype(genRenderbuffers)>("glGenRenderbuffers"); deleteRenderbuffers = load<decltype(deleteRenderbuffers)>("glDeleteRenderbuffers");
        bindRenderbuffer = load<decltype(bindRenderbuffer)>("glBindRenderbuffer"); genFrames = load<decltype(genFrames)>("glGenFramebuffers");
        deleteFrames = load<decltype(deleteFrames)>("glDeleteFramebuffers"); bindFrame = load<decltype(bindFrame)>("glBindFramebuffer");
        attach = load<decltype(attach)>("glFramebufferRenderbuffer"); status = load<decltype(status)>("glCheckFramebufferStatus");
        open = load<decltype(open)>("wglDXOpenDeviceNV"); close = load<decltype(close)>("wglDXCloseDeviceNV");
        registerObject = load<decltype(registerObject)>("wglDXRegisterObjectNV"); unregisterObject = load<decltype(unregisterObject)>("wglDXUnregisterObjectNV");
        lock = load<decltype(lock)>("wglDXLockObjectsNV"); unlock = load<decltype(unlock)>("wglDXUnlockObjectsNV");
    }
};
struct Export {
    Com<ID3D11Texture2D> texture;
    HANDLE handle = nullptr;
    int width = 0, height = 0;
    uint64_t generation = 0, resourceId = 0;
    void reset() { if (handle) CloseHandle(handle); handle = nullptr; texture.reset(); width = height = 0; }
};
WindowsTextureTickets tickets;
std::array<Export, 3> exports;
uint64_t nextResourceId = 0;
size_t peak = 0;
struct Wakeup {
    napi_env env = nullptr; napi_ref callback = nullptr;
    napi_threadsafe_function function = nullptr;
    std::mutex mutex;
} wakeup;
void notify(void *) {
    // May run on mpv's threads, including an isolated faulted session. No GL,
    // query or JS here. Serialize shutdown of the TSFN without joining a driver.
    std::lock_guard<std::mutex> lock(wakeup.mutex);
    if (wakeup.function && napi_acquire_threadsafe_function(wakeup.function) == napi_ok) {
        napi_call_threadsafe_function(wakeup.function, nullptr, napi_tsfn_nonblocking);
        napi_release_threadsafe_function(wakeup.function, napi_tsfn_release);
    }
}
void dispatch(napi_env env, napi_value, void *, void *) {
    if (!env || !wakeup.callback) return;
    napi_value callback, receiver, result;
    napi_get_reference_value(env, wakeup.callback, &callback); napi_get_undefined(env, &receiver);
    if (napi_call_function(env, receiver, callback, 0, nullptr, &result) == napi_pending_exception) {
        napi_value error; napi_get_and_clear_last_exception(env, &error); napi_fatal_exception(env, error);
    }
}
void detach() { if (wakeup.callback) { napi_delete_reference(wakeup.env, wakeup.callback); wakeup.callback = nullptr; } }
DWORD owner = 0;
void requireOwner() { if (GetCurrentThreadId() != owner) throw std::runtime_error("Windows texture producer requires its owner thread"); }
int64_t clockUs() { return static_cast<int64_t>(uv_hrtime() / 1000); }
struct Session {
    MpvCore playback;
    HWND window = nullptr; HDC dc = nullptr; HGLRC context = nullptr;
    Com<ID3D11Device> device; Com<ID3D11DeviceContext> immediate;
    Com<ID3D11Texture2D> bridge; Com<ID3D11Query> query;
    Gl gl; HANDLE interop = nullptr, registered = nullptr;
    GLuint buffer = 0, frame = 0;
    int width = 1, height = 1, bridgeWidth = 0, bridgeHeight = 0;
    bool visible = false, dirty = true, locked = false, uncertain = false, probePending = false, pendingProbe = false;
    uint64_t pending = 0;
    FrameTiming timing, pendingTiming;
    size_t pendingSlot = 0;
    uv_timer_t timer{};
    LUID adapter{};
};
Session *session = nullptr;
void current(Session &s) { if (!wglMakeCurrent(s.dc, s.context)) throw std::runtime_error("Cannot make Windows shared render context current"); }
void size(napi_env env, napi_value bounds, Session &s) {
    const auto next = frameLayout(namedNumber(env, bounds, "width"), namedNumber(env, bounds, "height"), namedNumber(env, bounds, "scale"));
    if (s.width != next.width || s.height != next.height) { s.width = next.width; s.height = next.height; s.dirty = true; }
}
D3D11_TEXTURE2D_DESC description(int width, int height) {
    D3D11_TEXTURE2D_DESC result{};
    result.Width = width; result.Height = height; result.MipLevels = result.ArraySize = 1;
    result.Format = DXGI_FORMAT_B8G8R8A8_UNORM; result.SampleDesc.Count = 1;
    result.Usage = D3D11_USAGE_DEFAULT; result.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    return result;
}
void disposeBridge(Session &s) {
    if (s.registered && !s.gl.unregisterObject(s.interop, s.registered)) {
        s.uncertain = true; throw std::runtime_error("Cannot unregister WGL bridge; resources quarantined");
    }
    s.registered = nullptr;
    if (s.frame) s.gl.deleteFrames(1, &s.frame);
    if (s.buffer) s.gl.deleteRenderbuffers(1, &s.buffer);
    s.frame = s.buffer = 0; s.bridge.reset(); s.bridgeWidth = s.bridgeHeight = 0;
}
void prepare(Session &s, size_t index) {
    if (s.width != s.bridgeWidth || s.height != s.bridgeHeight) {
        disposeBridge(s);
        auto desc = description(s.width, s.height);
        checked(s.device->CreateTexture2D(&desc, nullptr, s.bridge.put()), "Create private WGL bridge");
        s.gl.genRenderbuffers(1, &s.buffer);
        s.registered = s.gl.registerObject(s.interop, s.bridge.value, s.buffer, renderbuffer, 0x0001); // READ_WRITE_NV
        if (!s.registered) throw std::runtime_error("Cannot register D3D11 bridge with WGL");
        s.gl.genFrames(1, &s.frame); s.bridgeWidth = s.width; s.bridgeHeight = s.height;
    }
    auto &out = exports[index];
    if (out.width == s.width && out.height == s.height && out.generation == tickets.generation) return;
    out.reset();
    auto desc = description(s.width, s.height);
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    checked(s.device->CreateTexture2D(&desc, nullptr, out.texture.put()), "Create non-keyed NT export texture");
    Com<IDXGIResource1> resource;
    checked(out.texture->QueryInterface(__uuidof(IDXGIResource1), reinterpret_cast<void **>(resource.put())), "Query IDXGIResource1");
    checked(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &out.handle), "Create NT shared handle");
    out.width = s.width; out.height = s.height; out.generation = tickets.generation; out.resourceId = ++nextResourceId;
}
bool copyDone(Session &s) {
    BOOL done = FALSE;
    checked(s.device->GetDeviceRemovedReason(), "Windows playback device removed");
    const auto result = s.immediate->GetData(s.query.value, &done, sizeof(done), D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_FALSE) return false;
    checked(result, "Windows texture completion query");
    return result == S_OK && done == TRUE;
}
void shutdown() {
    requireOwner(); detach();
    if (!session) return;
    auto &s = *session;
    uv_timer_stop(&s.timer); s.visible = false;
    if (s.pending && !s.uncertain) {
        // Normal close can drain a short in-flight GPU copy; this deadline is
        // not permission to cancel/recycle a resource still used by the GPU.
        try {
            const auto deadline = clockUs() + 50000;
            while (!copyDone(s) && clockUs() < deadline) Sleep(1);
            if (copyDone(s)) { tickets.complete(s.pending); tickets.release(s.pending); s.pending = 0; }
            else s.uncertain = true;
        } catch (...) { s.uncertain = true; }
    }
    if (s.uncertain || s.locked) {
        tickets.quarantine(s.pending);
        try { s.playback.command({"set", "pause", "yes"}); } catch (...) {}
        // Keep the entire one faulted session and its private source alive.
        // No new pool/device is created until process restart.
        return;
    }
    if (s.context) current(s);
    s.playback.shutdown(); disposeBridge(s);
    if (s.interop && !s.gl.close(s.interop)) { s.uncertain = true; return; }
    s.interop = nullptr;
    wglMakeCurrent(nullptr, nullptr); if (s.context) wglDeleteContext(s.context);
    if (s.dc) ReleaseDC(s.window, s.dc);
    if (s.window) DestroyWindow(s.window);
    for (size_t i = 0; i < exports.size(); ++i) if (tickets.slots[i].state == WindowsTextureTickets::State::free) exports[i].reset();
    session = nullptr;
    // uv owns the timer storage until its asynchronous close callback.
    uv_close(reinterpret_cast<uv_handle_t *>(&s.timer), [](uv_handle_t *handle) { delete static_cast<Session *>(handle->data); });
}
napi_value create(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); shutdown();
        if (session) throw std::runtime_error("Windows GPU resources quarantined; restart the application");
        size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1) throw std::runtime_error("Windows shared texture create requires bounds");
        uv_loop_t *loop; checked(napi_get_uv_event_loop(env, &loop) == napi_ok ? S_OK : E_FAIL, "Get Electron event loop");
        session = new Session(); auto &s = *session;
        if (uv_timer_init(loop, &s.timer) != 0) { delete session; session = nullptr; throw std::runtime_error("Cannot create GPU query timer"); }
        s.timer.data = &s; uv_unref(reinterpret_cast<uv_handle_t *>(&s.timer));
        size(env, args[0], s); tickets.newGeneration(); peak = tickets.outstanding();
        WNDCLASSW cls{}; cls.style = CS_OWNDC; cls.lpfnWndProc = DefWindowProcW;
        cls.hInstance = GetModuleHandleW(nullptr); cls.lpszClassName = L"JavdexWindowsTextureProducer";
        if (!RegisterClassW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) throw std::runtime_error("Cannot register WGL drawable");
        s.window = CreateWindowW(cls.lpszClassName, L"", WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, cls.hInstance, nullptr);
        if (!s.window || !(s.dc = GetDC(s.window))) throw std::runtime_error("Cannot create hidden WGL drawable");
        PIXELFORMATDESCRIPTOR pixel{}; pixel.nSize = sizeof(pixel); pixel.nVersion = 1;
        pixel.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
        pixel.iPixelType = PFD_TYPE_RGBA; pixel.cColorBits = 32; pixel.cAlphaBits = 8;
        const auto format = ChoosePixelFormat(s.dc, &pixel);
        if (!format || !SetPixelFormat(s.dc, format, &pixel) || !(s.context = wglCreateContext(s.dc))) throw std::runtime_error("Cannot create Windows GL context");
        current(s);
        // Match the HWND renderer's core profile. A legacy compatibility
        // context can accept video but fail mpv's ASS/PGS draws on Intel GL.
        using CreateContext = HGLRC (WINAPI *)(HDC, HGLRC, const int *);
        auto createContext = load<CreateContext>("wglCreateContextAttribsARB");
        const int attributes[] = {0x2091, 3, 0x2092, 2, 0x9126, 1, 0};
        const auto core = createContext(s.dc, nullptr, attributes);
        if (!core) throw std::runtime_error("Cannot create Windows shared OpenGL 3.2 core context");
        wglMakeCurrent(nullptr, nullptr); wglDeleteContext(s.context); s.context = core;
        current(s); s.gl.initialize(s.dc);
        checked(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, s.device.put(), nullptr, s.immediate.put()), "Create hardware D3D11 device");
        Com<IDXGIDevice> dxgi; Com<IDXGIAdapter> adapter;
        checked(s.device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void **>(dxgi.put())), "Get DXGI device");
        checked(dxgi->GetAdapter(adapter.put()), "Get producer adapter"); DXGI_ADAPTER_DESC adapterDesc{};
        checked(adapter->GetDesc(&adapterDesc), "Get producer adapter LUID"); s.adapter = adapterDesc.AdapterLuid;
        s.interop = s.gl.open(s.device.value);
        if (!s.interop) throw std::runtime_error("GL cannot access the selected D3D11 adapter");
        D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0}; checked(s.device->CreateQuery(&query, s.query.put()), "Create GPU completion query");
        RenderConfig config; config.getProc = mpvProc; config.wakeup = notify; config.wakeupContext = &wakeup;
        s.playback.initialize(config);
        s.playback.setEventWakeup(notify, &wakeup);
    } catch (const std::exception &error) {
        try { shutdown(); } catch (...) { if (session) session->uncertain = true; }
        return fail(env, error.what());
    }
    return undefined(env);
}
napi_value bounds(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (!session || session->uncertain || count != 1) throw std::runtime_error("No Windows shared session");
        size(env, args[0], *session); notify(nullptr);
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value visibility(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 1; napi_value args[1]; bool value = false; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (!session || count != 1 || napi_get_value_bool(env, args[0], &value) != napi_ok) throw std::runtime_error("Invalid Windows visibility");
        if (session->visible != value) session->dirty = true;
        session->visible = value; notify(nullptr);
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value reset(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 1; napi_value args[1]; double value = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (!session || count != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value)
            || value <= session->timing.timeline || value > 9007199254740991.0 || std::floor(value) != value) throw std::runtime_error("Invalid Windows timeline");
        session->timing.reset(static_cast<uint64_t>(value)); session->dirty = true; notify(nullptr);
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value probe(napi_env env, napi_callback_info) {
    try { requireOwner(); if (session) { session->probePending = true; session->dirty = true; notify(nullptr); } }
    catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value next(napi_env env, napi_callback_info) {
    try {
        requireOwner(); if (!session) return undefined(env); auto &s = *session;
        if (s.uncertain) throw std::runtime_error("Windows producer requires process restart");
        current(s);
        const bool updated = s.playback.updateRequested(); s.dirty = s.dirty || updated;
        if (s.pending) {
            if (!copyDone(s)) {
                if (clockUs() - s.pendingTiming.renderStartUs > 5000000) throw std::runtime_error("Windows producer GPU completion timeout");
                if (updated && !s.playback.skipRender()) throw std::runtime_error("Cannot skip pending Windows frame");
                return undefined(env);
            }
            uv_timer_stop(&s.timer);
            const auto id = s.pending; s.pending = 0; tickets.complete(id);
            auto &out = exports[s.pendingSlot];
            napi_value result, handle; napi_create_object(env, &result);
            napi_create_buffer_copy(env, sizeof(out.handle), &out.handle, nullptr, &handle);
            napi_set_named_property(env, result, "ntHandle", handle);
            setNumber(env, result, "resourceId", out.resourceId); setNumber(env, result, "slot", s.pendingSlot);
            setNumber(env, result, "sequence", id); setNumber(env, result, "timeline", s.pendingTiming.timeline);
            setNumber(env, result, "width", out.width); setNumber(env, result, "height", out.height);
            setNumber(env, result, "renderStartUs", s.pendingTiming.renderStartUs); setNumber(env, result, "targetTimeUs", s.pendingTiming.targetTimeUs);
            setFlag(env, result, "producerComplete", true); setString(env, result, "pixelFormat", "bgra");
            setString(env, result, "colorContract", "bt709-srgb-rgb-full"); notify(nullptr);
            if (s.pendingProbe) setString(env, result, "selfTest", "solid-v1");
            return result;
        }
        const auto free = std::find_if(tickets.slots.begin(), tickets.slots.end(), [](const auto &ticket) { return ticket.state == WindowsTextureTickets::State::free; });
        if (!s.visible || free == tickets.slots.end()) {
            if (updated && !s.playback.skipRender()) throw std::runtime_error("Cannot skip unavailable Windows frame");
            return undefined(env);
        }
        if (!s.dirty) return undefined(env);
        const bool probe = s.probePending;
        const int viewportWidth = s.width, viewportHeight = s.height;
        if (probe) { s.width = 640; s.height = 360; }
        const auto index = static_cast<size_t>(free - tickets.slots.begin()); prepare(s, index);
        const auto delay = s.playback.nextFrameDelayUs(); s.timing.sample(clockUs(), delay);
        if (!s.gl.lock(s.interop, 1, &s.registered)) throw std::runtime_error("Cannot acquire WGL bridge");
        s.locked = true;
        s.gl.bindRenderbuffer(renderbuffer, s.buffer); s.gl.bindFrame(framebuffer, s.frame);
        s.gl.attach(framebuffer, attachment, renderbuffer, s.buffer);
        if (s.gl.status(framebuffer) != complete) throw std::runtime_error("Incomplete Windows shared framebuffer");
        glViewport(0, 0, s.width, s.height); glDisable(GL_SCISSOR_TEST); glClearColor(0.f, 0.f, 0.f, 1.f); glClear(GL_COLOR_BUFFER_BIT);
        // flipY=false matches the top-left shared image contract; four-corner
        // color fixtures on Windows must establish real driver orientation.
        if (probe) { glClearColor(64.f / 255, 191.f / 255, 128.f / 255, 1); glClear(GL_COLOR_BUFFER_BIT); }
        else if (!s.playback.render(s.width, s.height, s.frame, false)) throw std::runtime_error("Cannot render Windows shared texture");
        glFinish();
        const auto glError = glGetError();
        if (glError != GL_NO_ERROR) throw std::runtime_error("Windows shared GL render failed (error " + std::to_string(glError) + ")");
        if (!s.gl.unlock(s.interop, 1, &s.registered)) throw std::runtime_error("Cannot release WGL bridge");
        s.locked = false;
        s.pendingSlot = index; s.pendingTiming = s.timing; s.pending = tickets.begin(index);
        s.immediate->CopyResource(exports[index].texture.value, s.bridge.value);
        s.immediate->End(s.query.value); s.immediate->Flush(); s.dirty = probe;
        s.pendingProbe = probe; s.probePending = false; s.width = viewportWidth; s.height = viewportHeight;
        peak = std::max(peak, tickets.outstanding());
        // Asynchronous owner-thread polling while a copy is pending only.
        // No sleep loop or fixed frame-rate cap in normal playback.
        uv_timer_start(&s.timer, [](uv_timer_t *) { notify(nullptr); }, 1, 2);
        return undefined(env);
    } catch (const std::exception &error) {
        if (session) { session->uncertain = true; tickets.quarantine(session->pending); }
        return fail(env, error.what());
    }
}
napi_value release(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 1; napi_value args[1]; double id = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1 || napi_get_value_double(env, args[0], &id) != napi_ok || !std::isfinite(id)
            || id < 1 || id > 9007199254740991.0 || std::floor(id) != id) throw std::runtime_error("Invalid Windows release ticket");
        const auto ticket = static_cast<uint64_t>(id);
        for (size_t i = 0; i < tickets.slots.size(); ++i) if (tickets.slots[i].sequence == ticket && tickets.release(ticket)) {
            if (!session || exports[i].generation != tickets.generation) exports[i].reset();
            notify(nullptr); break;
        }
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value budget(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 1; napi_value args[1]; double value = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (!session || count != 1 || napi_get_value_double(env, args[0], &value) != napi_ok || !std::isfinite(value) || value < 8 || value > 40) throw std::runtime_error("Invalid Windows render budget");
        session->playback.command({"set", "video-timing-offset", std::to_string(value / 1000)});
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value setWakeup(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 1; napi_value args[1]; napi_valuetype type; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1 || napi_typeof(env, args[0], &type) != napi_ok || (type != napi_null && type != napi_function)) throw std::runtime_error("Invalid Windows wakeup");
        detach(); if (type == napi_function) { napi_create_reference(env, args[0], 1, &wakeup.callback); notify(nullptr); }
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value command(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 2; napi_value args[2]; bool generated = false; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (!session || session->uncertain || !count) throw std::runtime_error("No Windows shared playback session");
        if (count > 1 && napi_get_value_bool(env, args[1], &generated) != napi_ok) throw std::runtime_error("Invalid command scope");
        session->playback.command(env, args[0], generated);
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value subtitles(napi_env env, napi_callback_info info) {
    try { requireOwner(); if (!session || session->uncertain) throw std::runtime_error("No Windows shared playback session"); session->playback.generatedSubtitles(env, info); }
    catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value snapshot(napi_env env, bool consume) {
    try { requireOwner(); napi_value result;
        if (session) result = session->playback.state(env, consume); else { napi_create_object(env, &result); setFlag(env, result, "alive", false); }
        if (session && session->uncertain) setFlag(env, result, "alive", false);
        setNumber(env, result, "outstandingSurfaces", tickets.outstanding()); setNumber(env, result, "peakOutstandingSurfaces", peak);
        setNumber(env, result, "pixelWidth", session ? session->width : 0); setNumber(env, result, "pixelHeight", session ? session->height : 0);
        setNumber(env, result, "producerAdapterLuidLow", session ? session->adapter.LowPart : 0);
        setNumber(env, result, "producerAdapterLuidHigh", session ? session->adapter.HighPart : 0);
        return result;
    } catch (const std::exception &error) { return fail(env, error.what()); }
}
napi_value read(napi_env env, napi_callback_info) { return snapshot(env, true); }
napi_value inspect(napi_env env, napi_callback_info) { return snapshot(env, false); }
napi_value destroy(napi_env env, napi_callback_info) {
    try { shutdown(); } catch (const std::exception &error) { if (session) session->uncertain = true; return fail(env, error.what()); }
    return undefined(env);
}
void cleanup(void *) {
    try { shutdown(); } catch (...) {}
    // Faulted GPU/native allocations remain bounded and process-owned. Do not
    // manufacture completion while Electron/GPU teardown may still reference them.
    std::lock_guard<std::mutex> lock(wakeup.mutex);
    if (wakeup.function) { napi_release_threadsafe_function(wakeup.function, napi_tsfn_abort); wakeup.function = nullptr; }
}
}

napi_value initializeWindowsSharedTexture(napi_env env, napi_value exportsObject) {
    // Electron may own an embedded uv loop; uv_default_loop identity is not a
    // main-thread test. Ask the fixed Node runtime before touching global state.
    if (!javdex::nodeMainThread(env)) return javdex::fail(env, "Windows shared producer requires the Node main thread, not a worker thread");
    owner = GetCurrentThreadId(); wakeup.env = env;
    napi_value name; napi_create_string_utf8(env, "javdex-windows-shared-wakeup", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 1, 1, nullptr, nullptr, nullptr, dispatch, &wakeup.function) != napi_ok)
        return javdex::fail(env, "Cannot create Windows texture wakeup dispatcher");
    napi_unref_threadsafe_function(env, wakeup.function);
    napi_value object; napi_create_object(env, &object);
    napi_property_descriptor methods[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBounds", nullptr, bounds, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setVisible", nullptr, visibility, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resetTiming", nullptr, reset, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"requestSelfTest", nullptr, probe, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nextFrame", nullptr, next, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setRenderBudget", nullptr, budget, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setWakeup", nullptr, setWakeup, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"releaseFrame", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"command", nullptr, command, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"generatedSubtitles", nullptr, subtitles, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"state", nullptr, read, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroy", nullptr, destroy, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods);
    napi_set_named_property(env, exportsObject, "sharedTexture", object);
    napi_add_env_cleanup_hook(env, cleanup, nullptr); return exportsObject;
}
