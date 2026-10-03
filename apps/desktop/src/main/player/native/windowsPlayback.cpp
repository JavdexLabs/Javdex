// Main-process Win32 surface. Core/commands/events are shared with macOS;
// no independent visible player window and no frame transport through renderer IPC.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <GL/gl.h>
#include "mpvCore.h"
#include <algorithm>
#include <array>
#include <cstring>
#include <cwchar>

namespace {
using namespace javdex;
MpvCore playback;
HWND parent = nullptr, video = nullptr, cleanupWindow = nullptr, controls = nullptr;
HWND pauseButton = nullptr, dockButton = nullptr, fullscreenButton = nullptr, stopButton = nullptr;
HWND seekSlider = nullptr, volumeSlider = nullptr, timeLabel = nullptr;
HFONT controlsFont = nullptr;
UINT controlsDpi = 0;
HDC videoDc = nullptr, cleanupDc = nullptr;
HGLRC context = nullptr;
DWORD ownerThread = 0;
bool visible = false, controlsVisible = false, closing = false, focusFullscreen = false;
std::string presentation = "expanded";
struct Bounds { double x = 0, y = 0, width = 1, height = 1; } requested;
ULONGLONG lastInteraction = 0, singleClickAt = 0;
POINT lastMouse{};
int pixelWidth = 0, pixelHeight = 0;
constexpr wchar_t surfaceClass[] = L"JavdexLibmpvSurface";
enum ControlId { Pause = 1, Dock, Fullscreen, Stop, Seek, Volume };

void layout();
void destroyPlayer();
void interact() { lastInteraction = GetTickCount64(); }
void queue(const char *kind, double value = 0) { playback.queue(kind, value); interact(); }
bool owner() { return ownerThread == GetCurrentThreadId(); }
void requireOwner() { if (!owner()) throw std::runtime_error("Native playback requires its window owner thread"); }
void *getProcAddress(void *, const char *name) {
    PROC address = wglGetProcAddress(name);
    const auto invalid = reinterpret_cast<intptr_t>(address);
    if (!address || invalid == 1 || invalid == 2 || invalid == 3 || invalid == -1)
        address = GetProcAddress(GetModuleHandleW(L"opengl32.dll"), name);
    return reinterpret_cast<void *>(address);
}
bool draw(bool newFrame = false) {
    if (!video || !context || !playback.alive() || closing || !owner()) return false;
    if (!wglMakeCurrent(videoDc, context)) return false;
    RECT client{}; if (!GetClientRect(video, &client)) return false;
    pixelWidth = client.right; pixelHeight = client.bottom;
    if (!playback.render(pixelWidth, pixelHeight) || !SwapBuffers(videoDc)) return false;
    playback.swapped();
    if (newFrame) playback.presented(visible && IsWindowVisible(video) && !IsIconic(parent));
    return true;
}
void focusNext(HWND current, bool backwards) {
    if (presentation != "fullscreen" || !controls) { queue(backwards ? "focus-backward" : "focus-forward"); return; }
    interact(); controlsVisible = true; ShowWindow(controls, SW_SHOWNOACTIVATE); layout();
    const std::array<HWND, 7> order{video, seekSlider, pauseButton, volumeSlider, dockButton, fullscreenButton, stopButton};
    auto found = std::find(order.begin(), order.end(), current);
    const int index = found == order.end() ? 0 : static_cast<int>(found - order.begin());
    for (int step = 1; step <= static_cast<int>(order.size()); step++) {
        const int next = (index + (backwards ? -step : step) + static_cast<int>(order.size())) % static_cast<int>(order.size());
        if (IsWindowEnabled(order[next])) { SetFocus(order[next]); break; }
    }
}
bool key(HWND window, UINT message, WPARAM code, LPARAM flags) {
    if (message != WM_KEYDOWN && message != WM_SYSKEYDOWN) return false;
    const bool alt = (GetKeyState(VK_MENU) & 0x8000) != 0;
    const bool control = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    const bool shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
    const bool repeat = (flags & (static_cast<LPARAM>(1) << 30)) != 0;
    if (alt && !control && !shift && (code == VK_LEFT || code == VK_RIGHT)) {
        if (!repeat) queue(code == VK_LEFT ? "history-back" : "history-forward");
        return true;
    }
    if (alt || control || (GetKeyState(VK_LWIN) & 0x8000) || (GetKeyState(VK_RWIN) & 0x8000)) return false;
    if (code == VK_TAB) { focusNext(window, shift); return true; }
    if (code == VK_ESCAPE) { if (!repeat) queue("history-back"); return true; }
    if (window == seekSlider || window == volumeSlider) {
        if (code == VK_LEFT || code == VK_DOWN || code == VK_RIGHT || code == VK_UP) {
            if (IsWindowEnabled(window)) {
                const double step = window == seekSlider ? (shift ? 30 : 5) : 1;
                queue(window == seekSlider ? "seek-relative" : "volume-relative", (code == VK_LEFT || code == VK_DOWN) ? -step : step);
            }
            return true;
        }
    }
    if (window != video) {
        if (code == VK_SPACE || code == VK_RETURN) {
            if (!repeat && IsWindowEnabled(window)) {
                if (window == pauseButton) queue("toggle-pause");
                if (window == dockButton) queue("dock");
                if (window == fullscreenButton) queue("fullscreen");
                if (window == stopButton) queue("stop");
            }
            return true;
        }
        return false;
    }
    if (code == VK_SPACE) { if (!repeat) queue("toggle-pause"); }
    else if (code == 'M') { if (!repeat) queue("toggle-mute"); }
    else if (code == 'F') { if (!repeat) queue("fullscreen"); }
    else if (code == VK_LEFT || code == VK_RIGHT) queue("seek-relative", (code == VK_LEFT ? -1 : 1) * (shift ? 30 : 5));
    else return false;
    return true;
}
LRESULT CALLBACK controlInput(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR, DWORD_PTR) {
    if (key(window, message, wparam, lparam)) return 0;
    if (message == WM_GETDLGCODE) return DefSubclassProc(window, message, wparam, lparam) | DLGC_WANTTAB | DLGC_WANTARROWS;
    if (message == WM_SETFOCUS || message == WM_MOUSEMOVE || message == WM_LBUTTONDOWN) interact();
    if (message == WM_XBUTTONDOWN) { queue(GET_XBUTTON_WPARAM(wparam) == XBUTTON1 ? "history-back" : "history-forward"); return TRUE; }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, controlInput, 1);
    return DefSubclassProc(window, message, wparam, lparam);
}
LRESULT CALLBACK surfaceInput(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    // The hidden cleanup drawable never handles input or playback frames.
    if (window != video && window != controls) return DefWindowProcW(window, message, wparam, lparam);
    if (window == video && key(window, message, wparam, lparam)) return 0;
    if (message == WM_GETDLGCODE && window == video) return DLGC_WANTTAB | DLGC_WANTARROWS;
    if (message == WM_XBUTTONDOWN) { queue(GET_XBUTTON_WPARAM(wparam) == XBUTTON1 ? "history-back" : "history-forward"); return TRUE; }
    if (message == WM_MOUSEMOVE || message == WM_SETFOCUS) interact();
    if (window == video && (message == WM_LBUTTONDOWN || message == WM_LBUTTONDBLCLK)) {
        // Reveal before hit testing: a control click must not also pause video.
        if (presentation == "fullscreen" && controls && !controlsVisible) {
            POINT pointer{}; RECT area{}; GetCursorPos(&pointer); GetWindowRect(controls, &area);
            controlsVisible = true; ShowWindow(controls, SW_SHOWNOACTIVATE); interact(); layout();
            if (PtInRect(&area, pointer)) {
                ScreenToClient(controls, &pointer);
                HWND target = ChildWindowFromPointEx(controls, pointer, CWP_SKIPDISABLED | CWP_SKIPINVISIBLE);
                if (target && target != controls) {
                    GetCursorPos(&pointer); ScreenToClient(target, &pointer);
                    SendMessageW(target, WM_LBUTTONDOWN, wparam, MAKELPARAM(pointer.x, pointer.y));
                }
                return 0;
            }
        }
        SetFocus(video); interact();
        if (presentation == "docked") queue("expand");
        else if (message == WM_LBUTTONDBLCLK) { singleClickAt = 0; queue("fullscreen"); }
        else singleClickAt = GetTickCount64();
        return 0;
    }
    if (message == WM_COMMAND && window == controls && HIWORD(wparam) == BN_CLICKED) {
        switch (LOWORD(wparam)) {
            case Pause: queue("toggle-pause"); break; case Dock: queue("dock"); break;
            case Fullscreen: queue("fullscreen"); break; case Stop: queue("stop"); break;
        }
        return 0;
    }
    if (message == WM_HSCROLL && window == controls) {
        HWND slider = reinterpret_cast<HWND>(lparam);
        if (LOWORD(wparam) == TB_ENDTRACK) {
            const double value = static_cast<double>(SendMessageW(slider, TBM_GETPOS, 0, 0));
            if (slider == seekSlider) queue("seek", playback.number("duration") * value / 10000);
            if (slider == volumeSlider) queue("volume", value);
        }
        return 0;
    }
    if (message == WM_PAINT && window == video) {
        PAINTSTRUCT paint{}; BeginPaint(window, &paint); draw(); EndPaint(window, &paint); return 0;
    }
    if (message == WM_ERASEBKGND && window == video) return 1;
    if (message == WM_NCDESTROY && window == video) {
        // Never block a Win32 destruction callback waiting for mpv. A private,
        // compatible hidden drawable keeps the context valid for later cleanup.
        closing = true; visible = false; video = nullptr; videoDc = nullptr;
    }
    if (message == WM_NCDESTROY && window == controls) controls = nullptr;
    return DefWindowProcW(window, message, wparam, lparam);
}
void registerClass() {
    WNDCLASSEXW info{}; info.cbSize = sizeof(info); info.lpfnWndProc = surfaceInput;
    info.hInstance = GetModuleHandleW(nullptr); info.lpszClassName = surfaceClass;
    info.style = CS_OWNDC | CS_DBLCLKS; info.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    info.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    if (!RegisterClassExW(&info) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) throw std::runtime_error("Cannot register native playback window");
}
HWND widget(const wchar_t *klass, const wchar_t *label, DWORD style, int id) {
    HWND result = CreateWindowExW(0, klass, label, WS_CHILD | WS_VISIBLE | style, 0, 0, 1, 1,
        controls, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr);
    if (!result) throw std::runtime_error("Cannot create native playback control");
    SendMessageW(result, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
    if (id && !SetWindowSubclass(result, controlInput, 1, 0)) throw std::runtime_error("Cannot bind native playback control input");
    return result;
}
double scale() { const UINT dpi = parent ? GetDpiForWindow(parent) : 96; return (dpi ? dpi : 96) / 96.0; }
void updateFont() {
    const UINT dpi = GetDpiForWindow(parent);
    if (!controls || !dpi || controlsDpi == dpi) return;
    NONCLIENTMETRICSW metrics{}; metrics.cbSize = sizeof(metrics);
    if (!SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0, dpi)) return;
    HFONT next = CreateFontIndirectW(&metrics.lfMessageFont);
    if (!next) return;
    for (HWND control : {pauseButton, dockButton, fullscreenButton, stopButton, seekSlider, volumeSlider, timeLabel})
        SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(next), TRUE);
    if (controlsFont) DeleteObject(controlsFont);
    controlsFont = next; controlsDpi = dpi;
}
void place(HWND window, double x, double y, double width, double height, double dpi) {
    SetWindowPos(window, HWND_TOP, static_cast<int>(std::lround(x * dpi)), static_cast<int>(std::lround(y * dpi)),
        std::max(1, static_cast<int>(std::lround(width * dpi))), std::max(1, static_cast<int>(std::lround(height * dpi))), SWP_NOACTIVATE);
}
void layout() {
    if (!video || !parent || closing) return;
    const double dpi = scale(); RECT client{}; GetClientRect(parent, &client);
    const double width = client.right / dpi, height = client.bottom / dpi;
    if (controls) {
        updateFont();
        place(controls, 20, height - 80, std::max(1.0, width - 40), 64, dpi);
        place(seekSlider, 10, 2, std::max(1.0, width - 60), 20, dpi);
        place(pauseButton, 8, 28, 80, 28, dpi); place(dockButton, 96, 28, 64, 28, dpi);
        place(fullscreenButton, 168, 28, 90, 28, dpi); place(stopButton, 266, 28, 64, 28, dpi);
        place(volumeSlider, 346, 28, 120, 28, dpi); place(timeLabel, 480, 34, 160, 22, dpi);
    }
    double videoHeight = requested.height;
    if (presentation == "fullscreen" && controlsVisible) videoHeight = std::min(videoHeight, height - 88 - requested.y);
    place(video, requested.x, requested.y, requested.width, std::max(1.0, videoHeight), dpi);
    if (controls && controlsVisible) SetWindowPos(controls, HWND_TOP, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
}
void createControls() {
    if (controls) return;
    INITCOMMONCONTROLSEX init{sizeof(init), ICC_BAR_CLASSES};
    if (!InitCommonControlsEx(&init)) throw std::runtime_error("Cannot initialize native playback controls");
    controls = CreateWindowExW(0, surfaceClass, L"全屏播放控制", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
        0, 0, 1, 1, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!controls) throw std::runtime_error("Cannot create native playback controls");
    pauseButton = widget(L"BUTTON", L"暂停", WS_TABSTOP | BS_PUSHBUTTON, Pause);
    dockButton = widget(L"BUTTON", L"收起", WS_TABSTOP | BS_PUSHBUTTON, Dock);
    fullscreenButton = widget(L"BUTTON", L"退出全屏", WS_TABSTOP | BS_PUSHBUTTON, Fullscreen);
    stopButton = widget(L"BUTTON", L"停止", WS_TABSTOP | BS_PUSHBUTTON, Stop);
    seekSlider = widget(TRACKBAR_CLASSW, L"播放进度", WS_TABSTOP | TBS_NOTICKS, Seek);
    volumeSlider = widget(TRACKBAR_CLASSW, L"音量", WS_TABSTOP | TBS_NOTICKS, Volume);
    timeLabel = widget(L"STATIC", L"00:00:00", 0, 0);
    SendMessageW(seekSlider, TBM_SETRANGEMAX, FALSE, 10000);
    SendMessageW(volumeSlider, TBM_SETRANGEMAX, FALSE, 100);
}
void destroyPlayer() {
    if (!context && !video && !cleanupWindow) return;
    requireOwner(); closing = true; singleClickAt = 0;
    // Stop/replacement releases while parent is alive; `closed` may run after
    // parent destruction. cleanupDc stays valid in either case. Do not destroy
    // a player in `close`: renderer/foreground guards can still veto that close.
    if (context && !wglMakeCurrent(cleanupDc, context) && playback.alive()) throw std::runtime_error("Cannot make playback context current for cleanup");
    playback.shutdown();
    wglMakeCurrent(nullptr, nullptr);
    if (context) wglDeleteContext(context);
    context = nullptr;
    if (video && videoDc) ReleaseDC(video, videoDc);
    if (cleanupWindow && cleanupDc) ReleaseDC(cleanupWindow, cleanupDc);
    videoDc = cleanupDc = nullptr;
    if (controls && IsWindow(controls)) DestroyWindow(controls);
    if (controlsFont) DeleteObject(controlsFont);
    controlsFont = nullptr; controlsDpi = 0;
    if (video && IsWindow(video)) DestroyWindow(video);
    if (cleanupWindow) DestroyWindow(cleanupWindow);
    parent = video = cleanupWindow = controls = nullptr;
    pauseButton = dockButton = fullscreenButton = stopButton = seekSlider = volumeSlider = timeLabel = nullptr;
    controlsVisible = visible = focusFullscreen = false;
    pixelWidth = pixelHeight = 0; closing = false;
}
void updateBounds(napi_env env, napi_value rect) {
    requested = {namedNumber(env, rect, "x"), namedNumber(env, rect, "y"), namedNumber(env, rect, "width"), namedNumber(env, rect, "height")};
    layout();
}
napi_value create(napi_env env, napi_callback_info info) {
    size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 2) return fail(env, "Expected native parent handle and bounds");
    try {
        if (video || context || cleanupWindow) destroyPlayer();
        void *data = nullptr; size_t length = 0; HWND handle = nullptr;
        if (napi_get_buffer_info(env, args[0], &data, &length) != napi_ok || length != sizeof(handle)) throw std::runtime_error("Invalid HWND buffer");
        std::memcpy(&handle, data, sizeof(handle));
        if (!IsWindow(handle) || GetWindowThreadProcessId(handle, nullptr) != GetCurrentThreadId()) throw std::runtime_error("Expected main-thread Electron HWND");
        ownerThread = GetCurrentThreadId(); parent = handle; presentation = "expanded"; registerClass();
        video = CreateWindowExW(0, surfaceClass, L"视频画面", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN | WS_TABSTOP,
            0, 0, 1, 1, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
        RECT location{}; GetWindowRect(parent, &location);
        cleanupWindow = CreateWindowExW(0, surfaceClass, L"", WS_POPUP, location.left, location.top, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!video || !cleanupWindow) throw std::runtime_error("Cannot create native playback drawable");
        videoDc = GetDC(video); cleanupDc = GetDC(cleanupWindow);
        PIXELFORMATDESCRIPTOR format{}; format.nSize = sizeof(format); format.nVersion = 1;
        format.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
        format.iPixelType = PFD_TYPE_RGBA; format.cColorBits = 24; format.cAlphaBits = 8; format.iLayerType = PFD_MAIN_PLANE;
        const int pixelFormat = ChoosePixelFormat(videoDc, &format);
        if (!pixelFormat || !SetPixelFormat(videoDc, pixelFormat, &format) || !SetPixelFormat(cleanupDc, pixelFormat, &format))
            throw std::runtime_error("Cannot configure native OpenGL pixel format");
        context = wglCreateContext(cleanupDc);
        if (!context || !wglMakeCurrent(cleanupDc, context)) throw std::runtime_error("Cannot bootstrap native OpenGL context");
        using CreateContext = HGLRC (WINAPI *)(HDC, HGLRC, const int *);
        auto modern = reinterpret_cast<CreateContext>(getProcAddress(nullptr, "wglCreateContextAttribsARB"));
        if (!modern) throw std::runtime_error("OpenGL 3.2 core context is unavailable");
        const int attributes[] = {0x2091, 3, 0x2092, 2, 0x9126, 1, 0};
        HGLRC next = modern(cleanupDc, nullptr, attributes);
        if (!next) throw std::runtime_error("Cannot create OpenGL 3.2 core context");
        wglMakeCurrent(nullptr, nullptr); wglDeleteContext(context); context = next;
        if (!wglMakeCurrent(videoDc, context)) throw std::runtime_error("Cannot attach playback OpenGL context");
        updateBounds(env, args[1]); playback.initialize(getProcAddress);
        lastInteraction = GetTickCount64(); GetCursorPos(&lastMouse);
        return undefined(env);
    } catch (const std::exception &error) {
        const std::string reason = error.what();
        try { destroyPlayer(); } catch (...) { return fail(env, reason + "; native cleanup failed"); }
        return fail(env, reason);
    }
}
napi_value bounds(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    try { if (video && count == 1) { requireOwner(); updateBounds(env, args[0]); } }
    catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value setVisible(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; bool value = false; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count == 1) napi_get_value_bool(env, args[0], &value);
    if (video) { visible = value; ShowWindow(video, value ? SW_SHOWNOACTIVATE : SW_HIDE); }
    if (!value && controls) { controlsVisible = false; ShowWindow(controls, SW_HIDE); }
    return undefined(env);
}
napi_value setPresentation(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (!video || count != 1) return undefined(env);
    try {
        requireOwner(); const auto next = stringArg(env, args[0]);
        if (next != "expanded" && next != "docked" && next != "fullscreen") throw std::runtime_error("Invalid playback presentation");
        if (next == presentation) return undefined(env); // periodic viewport reports do not reset auto-hide
        focusFullscreen = next == "fullscreen"; presentation = next; singleClickAt = 0; interact();
        if (presentation == "fullscreen") createControls();
        controlsVisible = presentation == "fullscreen" && visible;
        if (controls) ShowWindow(controls, controlsVisible ? SW_SHOWNOACTIVATE : SW_HIDE);
        layout();
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value command(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1 || closing || !video) return fail(env, "No native playback session");
    try { requireOwner(); playback.command(env, args[0]); } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value read(napi_env env, bool drain) {
    if (closing && drain) { try { destroyPlayer(); } catch (const std::exception &error) { return fail(env, error.what()); } }
    napi_value result = playback.state(env, drain);
    if (!playback.alive()) return result;
    setNumber(env, result, "pixelWidth", pixelWidth); setNumber(env, result, "pixelHeight", pixelHeight);
    const HWND focus = GetFocus();
    setString(env, result, "focusedControl", focus == video ? "video" : focus == seekSlider ? "seek" : focus == pauseButton ? "pause"
        : focus == volumeSlider ? "volume" : focus == dockButton ? "dock" : focus == fullscreenButton ? "fullscreen" : focus == stopButton ? "stop" : "web-content");
    setFlag(env, result, "fullscreenControlsVisible", controlsVisible);
    return result;
}
napi_value state(napi_env env, napi_callback_info) { return read(env, true); }
napi_value inspect(napi_env env, napi_callback_info) { return read(env, false); }
napi_value render(napi_env env, napi_callback_info) {
    if (closing || !video || !context) return undefined(env);
    try {
        requireOwner(); const auto now = GetTickCount64();
        if (singleClickAt && now - singleClickAt > GetDoubleClickTime()) { singleClickAt = 0; queue("toggle-pause"); }
        if (focusFullscreen && visible && presentation == "fullscreen" && GetForegroundWindow() == parent) { SetFocus(video); focusFullscreen = false; }
        if (controls && visible && presentation == "fullscreen") {
            POINT pointer{}; RECT area{}; GetCursorPos(&pointer); GetWindowRect(controls, &area);
            if (pointer.x != lastMouse.x || pointer.y != lastMouse.y) { lastMouse = pointer; interact(); }
            const bool show = playback.number("pause") || IsChild(controls, GetFocus()) || PtInRect(&area, pointer) || now - lastInteraction <= 3000;
            if (show != controlsVisible) { controlsVisible = show; ShowWindow(controls, show ? SW_SHOWNOACTIVATE : SW_HIDE); layout(); }
            SetWindowTextW(pauseButton, playback.number("eof-reached") ? L"从头重播" : playback.number("pause") ? L"播放" : L"暂停");
            EnableWindow(seekSlider, playback.number("seekable") && playback.number("duration") > 0);
            if (GetCapture() != seekSlider) SendMessageW(seekSlider, TBM_SETPOS, TRUE,
                static_cast<LPARAM>(std::clamp(playback.number("time-pos") / std::max(1.0, playback.number("duration")), 0.0, 1.0) * 10000));
            if (GetCapture() != volumeSlider) SendMessageW(volumeSlider, TBM_SETPOS, TRUE, static_cast<LPARAM>(std::clamp(playback.number("volume"), 0.0, 100.0)));
            const int seconds = static_cast<int>(std::max(0.0, playback.number("time-pos")));
            wchar_t time[32]; swprintf_s(time, L"%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60); SetWindowTextW(timeLabel, time);
        }
        if (!wglMakeCurrent(videoDc, context)) throw std::runtime_error("Cannot make playback OpenGL context current");
        if (playback.updateRequested() && !draw(true)) throw std::runtime_error("Native frame rendering or swap failed");
    } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
napi_value destroy(napi_env env, napi_callback_info) {
    try { destroyPlayer(); } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
void cleanup(void *) { try { destroyPlayer(); } catch (...) { /* Environment is closing; normal shutdown happens earlier. */ } }
} // namespace

napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBounds", nullptr, bounds, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setVisible", nullptr, setVisible, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setPresentation", nullptr, setPresentation, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"command", nullptr, command, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"state", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"render", nullptr, render, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroy", nullptr, destroy, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    napi_add_env_cleanup_hook(env, cleanup, nullptr);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
