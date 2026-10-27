// Isolated-process Windows producer. No HWND is embedded in the player page.
// ANGLE renders directly into a free shared slot; glFinish completes writes before handoff.
// Producer completion and consumer final release both precede slot reuse.
// Electron duplicates our NT handle and transports it, not its numeric bytes.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_6.h>
#include <GL/gl.h>
#include <uv.h>
#include "mpvCore.h"
#include "windowsAngleContext.h"
#include "frameTiming.h"
#include "windowsTextureTickets.h"
#include <memory>
#include <mutex>
#include <chrono>
#include <cstring>
#include <cmath>
#include <optional>

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
HRESULT createHardwareDevice(IDXGIAdapter *adapter, Com<ID3D11Device> &device, Com<ID3D11DeviceContext> &context) {
    const auto driver = adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE;
    auto result = D3D11CreateDevice(adapter, driver, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put());
    if (FAILED(result)) result = D3D11CreateDevice(adapter, driver, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put());
    return result;
}
WindowsAngleContext *activeAngle = nullptr;
void *proc(const char *name) { return activeAngle ? activeAngle->proc(name) : nullptr; }
template<class T> T load(const char *name) {
    auto result = reinterpret_cast<T>(proc(name));
    if (!result) throw std::runtime_error(std::string("Missing Windows GL entry: ") + name);
    return result;
}
void *mpvProc(void *, const char *name) { return proc(name); }
struct Timing {
    uint64_t count = 0; double total = 0, maximum = 0, last = 0;
    void record(int64_t us) { last = static_cast<double>(us) / 1000; ++count; total += last; maximum = std::max(maximum, last); }
    napi_value snapshot(napi_env env) const {
        napi_value value; napi_create_object(env, &value);
        setNumber(env, value, "samples", count); setNumber(env, value, "meanMs", count ? total / count : 0);
        setNumber(env, value, "maxMs", maximum); setNumber(env, value, "lastMs", last); return value;
    }
};
struct Gl {
    void (APIENTRY *viewport)(GLint, GLint, GLsizei, GLsizei) = nullptr;
    void (APIENTRY *disable)(GLenum) = nullptr;
    void (APIENTRY *clearColor)(GLfloat, GLfloat, GLfloat, GLfloat) = nullptr;
    void (APIENTRY *clear)(GLbitfield) = nullptr;
    void (APIENTRY *finish)() = nullptr;
    GLenum (APIENTRY *getError)() = nullptr;
    const GLubyte *(APIENTRY *getString)(GLenum) = nullptr;
    void initialize() {
        viewport = load<decltype(viewport)>("glViewport"); disable = load<decltype(disable)>("glDisable");
        clearColor = load<decltype(clearColor)>("glClearColor"); clear = load<decltype(clear)>("glClear");
        finish = load<decltype(finish)>("glFinish"); getError = load<decltype(getError)>("glGetError");
        getString = load<decltype(getString)>("glGetString");
    }
};
struct Export {
    Com<ID3D11Texture2D> texture;
    EGLSurface surface = EGL_NO_SURFACE;
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
struct PendingOutput {
    uint64_t sequence = 0; size_t slot = 0;
    FrameTiming timing;
    bool probe = false;
};
struct Session {
    MpvCore playback;
    WindowsAngleContext angle;
    std::string renderer, vendor, glVersion, adapterName;
    UINT vendorId = 0, deviceId = 0;
    std::string adapterSelection = "system-default";
    Timing renderCall, finishWait, outputAcquire, outputRelease, producerReady;
    uint64_t directFrames = 0;
    Com<ID3D11Device> device; Com<ID3D11DeviceContext> immediate;
    Com<ID3D11Texture2D> control;
    Gl gl;
    int width = 1, height = 1;
    bool visible = false, dirty = true, locked = false, uncertain = false, probePending = false, controlReady = false;
    // Writes are already complete (glFinish + unbind). Preserve the original
    // timeline until the next owner-thread call hands this frame to Electron.
    std::optional<PendingOutput> pending;
    FrameTiming timing;
    LUID adapter{};
};
Session *session = nullptr;
void current(Session &s) { s.angle.current(); }
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
void retireExport(Session *s, Export &out) {
    if (out.surface != EGL_NO_SURFACE) {
        if (!s || !s->angle.active()) throw std::runtime_error("ANGLE output outlived its context");
        s->angle.destroyTextureSurface(out.surface);
    }
    out.reset();
}
void prepare(Session &s, size_t index) {
    auto &out = exports[index];
    if (out.width == s.width && out.height == s.height && out.generation == tickets.generation) return;
    retireExport(&s, out);
    auto desc = description(s.width, s.height);
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    checked(s.device->CreateTexture2D(&desc, nullptr, out.texture.put()), "Create non-keyed NT export texture");
    Com<IDXGIResource1> resource;
    checked(out.texture->QueryInterface(__uuidof(IDXGIResource1), reinterpret_cast<void **>(resource.put())), "Query IDXGIResource1");
    checked(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &out.handle), "Create NT shared handle");
    out.surface = s.angle.createTextureSurface(out.texture.value);
    out.width = s.width; out.height = s.height; out.generation = tickets.generation; out.resourceId = ++nextResourceId;
}
void shutdown() {
    requireOwner(); detach();
    if (!session) return;
    auto &s = *session;
    s.visible = false;
    if (s.uncertain || s.locked) {
        for (const auto &slot : tickets.slots) if (slot.state == WindowsTextureTickets::State::producing) tickets.quarantine(slot.sequence);
        try { s.playback.command({"set", "pause", "yes"}); } catch (...) {}
        // Keep the one faulted session alive until its isolated process exits.
        // Never recycle allocations whose GPU completion is uncertain.
        return;
    }
    if (s.pending) {
        tickets.complete(s.pending->sequence); tickets.release(s.pending->sequence); s.pending.reset();
    }
    if (s.controlReady) current(s);
    s.playback.shutdown();
    // Every output write finished before handoff. Retire EGL views now, but
    // retain consumer-owned textures/handles until their actual final release.
    if (s.angle.active()) {
        s.angle.unbind();
        for (auto &out : exports) s.angle.destroyTextureSurface(out.surface);
    }
    if (!s.angle.close()) { s.uncertain = true; return; }
    activeAngle = nullptr;
    for (size_t i = 0; i < exports.size(); ++i) if (tickets.slots[i].state == WindowsTextureTickets::State::free) retireExport(&s, exports[i]);
    session = nullptr;
    delete &s;
}
napi_value create(napi_env env, napi_callback_info info) {
    try {
        requireOwner(); shutdown();
        if (session) throw std::runtime_error("Windows GPU resources quarantined; restart the application");
        size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count < 1) throw std::runtime_error("Windows shared texture create requires bounds");
        session = new Session(); auto &s = *session;
        size(env, args[0], s); tickets.newGeneration(); peak = tickets.outstanding();
        const auto diagnostics = _wgetenv(L"JAVDEX_PLAYBACK_DIAGNOSTICS");
        const auto selected = _wgetenv(L"JAVDEX_WINDOWS_VIDEO_ADAPTER");
        UINT targetVendor = 0, targetDevice = 0;
        int targetPreference = 0; bool hasTargetLuid = false; LUID targetLuid{};
        napi_valuetype adapterType = napi_undefined;
        if (count > 1) napi_typeof(env, args[1], &adapterType);
        if (adapterType != napi_undefined) {
            if (adapterType != napi_object) throw std::runtime_error("Invalid Chromium GPU identity");
            const auto vendor = namedNumber(env, args[1], "vendorId"), id = namedNumber(env, args[1], "deviceId");
            if (!std::isfinite(vendor) || !std::isfinite(id) || vendor < 1 || vendor > 65535 || id < 1 || id > 65535
                || std::floor(vendor) != vendor || std::floor(id) != id) throw std::runtime_error("Invalid Chromium GPU identity");
            targetVendor = static_cast<UINT>(vendor); targetDevice = static_cast<UINT>(id);
            s.adapterSelection = "chromium-active-pci";
            bool hasPreference = false, low = false, high = false;
            napi_has_named_property(env, args[1], "gpuPreference", &hasPreference);
            if (hasPreference) {
                const auto preference = namedNumber(env, args[1], "gpuPreference");
                if (preference != 2 && preference != 3) throw std::runtime_error("Invalid Chromium GPU preference");
                targetPreference = static_cast<int>(preference);
            }
            napi_has_named_property(env, args[1], "adapterLuidLow", &low); napi_has_named_property(env, args[1], "adapterLuidHigh", &high);
            if (low != high) throw std::runtime_error("Incomplete Windows adapter LUID");
            if (low) {
                const auto lo = namedNumber(env, args[1], "adapterLuidLow"), hi = namedNumber(env, args[1], "adapterLuidHigh");
                if (!std::isfinite(lo) || !std::isfinite(hi) || lo < 0 || lo > 4294967295.0 || hi < -2147483648.0 || hi > 2147483647.0
                    || std::floor(lo) != lo || std::floor(hi) != hi) throw std::runtime_error("Invalid Windows adapter LUID");
                targetLuid = {static_cast<DWORD>(lo), static_cast<LONG>(hi)}; hasTargetLuid = true;
            }
        }
        if (diagnostics && std::wstring(diagnostics) == L"1" && selected) {
            // Acceptance only: never guess between identical adapters or alter
            // the user's Windows graphics preferences.
            const std::wstring identity(selected);
            if (identity.size() != 9 || identity[4] != L':' || identity.find_first_not_of(L"0123456789abcdefABCDEF:") != std::wstring::npos)
                throw std::runtime_error("Expected diagnostic GPU identity VVVV:DDDD");
            const auto vendor = std::stoul(identity.substr(0, 4), nullptr, 16), id = std::stoul(identity.substr(5), nullptr, 16);
            if (targetVendor && (targetVendor != vendor || targetDevice != id))
                throw std::runtime_error("Diagnostic GPU conflicts with the Chromium consumer");
            targetVendor = vendor; targetDevice = id; s.adapterSelection = "diagnostic-override";
        }
        if (targetVendor) {
            Com<IDXGIFactory1> factory;
            checked(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void **>(factory.put())), "Enumerate diagnostic GPU");
            // Chromium GPUInfo assigns preference=2/3 from these exact DXGI
            // index-zero queries (low-power/high-performance). Recover that
            // LUID, then require the reported PCI identity too. Never choose
            // the first of multiple identical physical/virtual adapters.
            if (targetPreference) {
                Com<IDXGIFactory6> preferences; Com<IDXGIAdapter1> preferred;
                checked(factory->QueryInterface(__uuidof(IDXGIFactory6), reinterpret_cast<void **>(preferences.put())), "Read Chromium DXGI preference");
                checked(preferences->EnumAdapterByGpuPreference(0, targetPreference == 2 ? DXGI_GPU_PREFERENCE_MINIMUM_POWER : DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                    __uuidof(IDXGIAdapter1), reinterpret_cast<void **>(preferred.put())), "Resolve Chromium DXGI preference");
                DXGI_ADAPTER_DESC1 identity{}; checked(preferred->GetDesc1(&identity), "Read preferred adapter identity");
                if (identity.VendorId != targetVendor || identity.DeviceId != targetDevice || (hasTargetLuid
                    && (targetLuid.LowPart != identity.AdapterLuid.LowPart || targetLuid.HighPart != identity.AdapterLuid.HighPart)))
                    throw std::runtime_error("Chromium GPU preference no longer matches its active identity");
                targetLuid = identity.AdapterLuid; hasTargetLuid = true; s.adapterSelection = "chromium-active-preference";
            }
            std::vector<LUID> matches;
            Com<IDXGIAdapter1> selectedAdapter;
            for (UINT index = 0;; ++index) {
                Com<IDXGIAdapter1> candidate;
                const auto result = factory->EnumAdapters1(index, candidate.put());
                if (result == DXGI_ERROR_NOT_FOUND) break;
                checked(result, "Enumerate diagnostic adapter");
                DXGI_ADAPTER_DESC1 description{}; checked(candidate->GetDesc1(&description), "Read diagnostic adapter");
                if (description.VendorId == targetVendor && description.DeviceId == targetDevice && !(description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) {
                    const auto luid = description.AdapterLuid;
                    if (hasTargetLuid && (luid.LowPart != targetLuid.LowPart || luid.HighPart != targetLuid.HighPart)) continue;
                    if (std::any_of(matches.begin(), matches.end(), [&](const auto &id) { return id.LowPart == luid.LowPart && id.HighPart == luid.HighPart; })) continue;
                    matches.push_back(luid);
                    selectedAdapter.reset(); selectedAdapter.value = candidate.value; selectedAdapter.value->AddRef();
                }
            }
            if (matches.size() != 1) throw std::runtime_error("Chromium GPU identity is missing or ambiguous in DXGI (" + std::to_string(targetVendor)
                + ":" + std::to_string(targetDevice) + ", matches=" + std::to_string(matches.size()) + ")");
            checked(createHardwareDevice(selectedAdapter.value, s.device, s.immediate), "Create Chromium-matched hardware device");
        }
        if (!s.device.value) checked(createHardwareDevice(nullptr, s.device, s.immediate), "Create hardware D3D11 device");
        Com<IDXGIDevice> dxgi; Com<IDXGIAdapter> adapter;
        checked(s.device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void **>(dxgi.put())), "Get DXGI device");
        checked(dxgi->GetAdapter(adapter.put()), "Get producer adapter"); DXGI_ADAPTER_DESC adapterDesc{};
        checked(adapter->GetDesc(&adapterDesc), "Get producer adapter LUID"); s.adapter = adapterDesc.AdapterLuid;
        s.vendorId = adapterDesc.VendorId; s.deviceId = adapterDesc.DeviceId;
        const int length = WideCharToMultiByte(CP_UTF8, 0, adapterDesc.Description, -1, nullptr, 0, nullptr, nullptr);
        if (length > 0) { std::vector<char> text(length); WideCharToMultiByte(CP_UTF8, 0, adapterDesc.Description, -1, text.data(), length, nullptr, nullptr); s.adapterName = text.data(); }
        s.angle.initialize(s.device.value); activeAngle = &s.angle; s.gl.initialize();
        // Only this private 1x1 pbuffer may be current during mpv updates,
        // frame skipping and teardown. Consumer-owned slots remain untouched.
        auto desc = description(1, 1);
        checked(s.device->CreateTexture2D(&desc, nullptr, s.control.put()), "Create private ANGLE control target");
        s.angle.bindTexture(s.control.value); s.controlReady = true;
        RenderConfig config; config.getProc = mpvProc; config.hardwareDecode = "d3d11va,auto-copy";
        config.wakeup = notify; config.wakeupContext = &wakeup;
        s.playback.initialize(config);
        const auto text = [&](GLenum name) { const auto value = s.gl.getString(name); return std::string(value ? reinterpret_cast<const char *>(value) : ""); };
        s.vendor = text(GL_VENDOR); s.renderer = text(GL_RENDERER); s.glVersion = text(GL_VERSION);
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
        if (s.pending) {
            checked(s.device->GetDeviceRemovedReason(), "Windows playback device removed");
            const auto completed = *s.pending; s.pending.reset(); tickets.complete(completed.sequence);
            s.producerReady.record(clockUs() - completed.timing.renderStartUs);
            auto &out = exports[completed.slot];
            napi_value result, handle; napi_create_object(env, &result);
            napi_create_buffer_copy(env, sizeof(out.handle), &out.handle, nullptr, &handle);
            napi_set_named_property(env, result, "ntHandle", handle);
            setNumber(env, result, "resourceId", out.resourceId); setNumber(env, result, "slot", completed.slot);
            setNumber(env, result, "sequence", completed.sequence); setNumber(env, result, "timeline", completed.timing.timeline);
            setNumber(env, result, "width", out.width); setNumber(env, result, "height", out.height);
            setNumber(env, result, "renderStartUs", completed.timing.renderStartUs); setNumber(env, result, "targetTimeUs", completed.timing.targetTimeUs);
            setFlag(env, result, "producerComplete", true); setString(env, result, "pixelFormat", "bgra");
            setString(env, result, "colorContract", "bt709-srgb-rgb-full"); notify(nullptr);
            if (completed.probe) setString(env, result, "selfTest", "solid-v1");
            return result;
        }
        current(s);
        const bool updated = s.playback.updateRequested(); s.dirty = s.dirty || updated;
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
        PendingOutput work; work.slot = index; work.sequence = tickets.begin(index); work.timing = s.timing; work.probe = probe;
        s.pending = work;
        const auto acquireStarted = clockUs();
        s.angle.current(exports[index].surface);
        s.outputAcquire.record(clockUs() - acquireStarted); s.locked = true;
        s.gl.viewport(0, 0, s.width, s.height); s.gl.disable(GL_SCISSOR_TEST); s.gl.clearColor(0.f, 0.f, 0.f, 1.f); s.gl.clear(GL_COLOR_BUFFER_BIT);
        // flipY=false matches the top-left shared image contract; four-corner
        // color fixtures on Windows must establish real driver orientation.
        const auto renderStarted = clockUs();
        if (probe) { s.gl.clearColor(64.f / 255, 191.f / 255, 128.f / 255, 1); s.gl.clear(GL_COLOR_BUFFER_BIT); }
        else if (!s.playback.render(s.width, s.height, 0, false)) throw std::runtime_error("Cannot render Windows shared texture");
        s.renderCall.record(clockUs() - renderStarted);
        const auto finishStarted = clockUs(); s.gl.finish(); s.finishWait.record(clockUs() - finishStarted);
        const auto glError = s.gl.getError();
        if (glError != GL_NO_ERROR) throw std::runtime_error("Windows shared GL render failed (error " + std::to_string(glError) + ")");
        const auto releaseStarted = clockUs();
        s.angle.unbind(); s.outputRelease.record(clockUs() - releaseStarted); s.locked = false;
        ++s.directFrames; s.dirty = probe;
        s.probePending = false; s.width = viewportWidth; s.height = viewportHeight;
        peak = std::max(peak, tickets.outstanding());
        notify(nullptr); // glFinish already established completion; no query timer.
        return undefined(env);
    } catch (const std::exception &error) {
        if (session) {
            session->uncertain = true;
            for (const auto &slot : tickets.slots) if (slot.state == WindowsTextureTickets::State::producing) tickets.quarantine(slot.sequence);
        }
        return fail(env, error.what());
    }
}
napi_value release(napi_env env, napi_callback_info info) {
    try { requireOwner(); size_t count = 1; napi_value args[1]; double id = 0; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
        if (count != 1 || napi_get_value_double(env, args[0], &id) != napi_ok || !std::isfinite(id)
            || id < 1 || id > 9007199254740991.0 || std::floor(id) != id) throw std::runtime_error("Invalid Windows release ticket");
        const auto ticket = static_cast<uint64_t>(id);
        for (size_t i = 0; i < tickets.slots.size(); ++i) if (tickets.slots[i].sequence == ticket && tickets.release(ticket)) {
            if (!session || exports[i].generation != tickets.generation) retireExport(session, exports[i]);
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
        if (session) {
            auto &s = *session;
            setString(env, result, "producerBackend", "angle-d3d11");
            setString(env, result, "producerOutput", "direct-shared");
            setNumber(env, result, "directOutputFrames", s.directFrames);
            setString(env, result, "producerSynchronization", "gl-finish");
            setString(env, result, "producerAdapterName", s.adapterName); setNumber(env, result, "producerVendorId", s.vendorId); setNumber(env, result, "producerDeviceId", s.deviceId);
            setString(env, result, "producerAdapterSelection", s.adapterSelection);
            setString(env, result, "producerGLVendor", s.vendor); setString(env, result, "producerGLRenderer", s.renderer); setString(env, result, "producerGLVersion", s.glVersion);
            napi_value decoder; napi_valuetype decoderType;
            if (napi_get_named_property(env, result, "hwdec-current", &decoder) == napi_ok
                && napi_typeof(env, decoder, &decoderType) == napi_ok && decoderType == napi_string
                && stringArg(env, decoder) == "d3d11va") {
                // mpv's D3D11/EGL mapper takes this exact ANGLE D3D device.
                setNumber(env, result, "decoderVendorId", s.vendorId); setNumber(env, result, "decoderDeviceId", s.deviceId);
                setNumber(env, result, "decoderAdapterLuidLow", s.adapter.LowPart); setNumber(env, result, "decoderAdapterLuidHigh", s.adapter.HighPart);
                setString(env, result, "decoderDeviceIdentitySource", "angle-shared-device");
            } else {
                bool known = false; napi_has_named_property(env, result, "decoderVendorId", &known);
                if (known) setString(env, result, "decoderDeviceIdentitySource", "decoded-frame");
            }
            napi_value timings; napi_create_object(env, &timings);
            for (const auto &item : std::vector<std::pair<const char *, const Timing *>>{{"renderCall", &s.renderCall}, {"glFinishWait", &s.finishWait},
                {"outputAcquire", &s.outputAcquire}, {"outputRelease", &s.outputRelease}, {"producerReadyWall", &s.producerReady}})
                napi_set_named_property(env, timings, item.first, item.second->snapshot(env));
            napi_set_named_property(env, result, "producerTimings", timings);
        }
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
