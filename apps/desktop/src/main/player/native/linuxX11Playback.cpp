// X11/XWayland only: a child of the explicitly selected Electron X11 parent.
// All calls on our Display/GL context are serialized on the helper owner thread;
// no late XInitThreads, no shared Display handed to decoder threads, no Wayland
// ID casting and no visible top-level playback window. AT-SPI remains unverified.
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/XKBlib.h>
#include <X11/keysym.h>
#include <X11/Xft/Xft.h>
#include <GL/glx.h>
#include <GL/glxext.h>
#define JAVDEX_STANDALONE_PLAYBACK
#include "mpvCore.h"
#include "x11Controls.h"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <set>
#include <thread>

namespace {
using namespace javdex;
using x11::Control;
MpvCore playback;
Display *display = nullptr;
Window parent = None, video = None, toolbar = None;
GLXWindow drawable = None;
GLXPbuffer cleanupDrawable = None;
GLXContext context = nullptr;
Colormap colormap = None;
XVisualInfo *visual = nullptr;
XftDraw *textDraw = nullptr;
XftFont *font = nullptr;
XftColor textColor{};
GC graphics = nullptr;
unsigned long background = 0, foreground = 0;
std::thread::id ownerThread;
std::string presentation = "expanded";
struct Bounds { double x = 0, y = 0, width = 1, height = 1, scale = 1; } requested;
x11::Controls controls;
bool visible = false, controlsVisible = false, closing = false, focusFullscreen = false, detectableRepeat = false;
Control pressed = Control::Empty;
std::set<unsigned int> heldKeys;
uint64_t lastInteraction = 0, singleClickAt = 0;
int clickX = 0, clickY = 0, lastPointerX = -1, lastPointerY = -1, pixelWidth = 1, pixelHeight = 1;
double draggedFraction = 0;
double fontScale = 0;
uint64_t now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void requireOwner() { if (ownerThread != std::this_thread::get_id()) throw std::runtime_error("X11 playback requires its window owner thread"); }

// A parent may disappear between attribute query and GL submission. Trap our
// connection's asynchronous X errors, not errors from Chromium's connection.
class XErrors {
    // Xlib's handler is process-global: Chromium can call it on other threads.
    // Only this thread may inspect its stack-owned traps; foreign connections
    // use the stable previous handler without dereferencing a trap's lifetime.
    static thread_local XErrors *active;
    static std::atomic<XErrorHandler> fallback;
    Display *connection;
    XErrors *previous;
    XErrorHandler previousHandler, outerHandler;
    int code = 0;
    static int capture(Display *connection, XErrorEvent *error) {
        for (auto scope = active; scope; scope = scope->previous) {
            if (scope->connection == connection) { if (!scope->code) scope->code = error->error_code; return 0; }
        }
        const auto handler = active ? active->outerHandler : fallback.load();
        return handler && handler != capture ? handler(connection, error) : 0;
    }
public:
    explicit XErrors(Display *connection) : connection(connection), previous(active) {
        previousHandler = XSetErrorHandler(capture);
        if (previousHandler != capture) fallback.store(previousHandler);
        outerHandler = previous ? previous->outerHandler : previousHandler;
        active = this;
    }
    ~XErrors() { XSync(connection, False); active = previous; XSetErrorHandler(previousHandler); }
    void check() {
        XSync(connection, False);
        if (code) throw std::runtime_error("X11 playback surface is unavailable (X error " + std::to_string(code) + ")");
    }
};
thread_local XErrors *XErrors::active = nullptr;
std::atomic<XErrorHandler> XErrors::fallback{nullptr};
void layout();
void cancelInput() {
    if (display && pressed != Control::Empty) XUngrabPointer(display, CurrentTime);
    pressed = Control::Empty; singleClickAt = 0; heldKeys.clear();
}
void interact() { lastInteraction = now(); }
void queue(const char *kind, double value = 0) { playback.queue(kind, value); interact(); }
bool seekable() { return playback.number("seekable") && playback.number("duration") > 0; }
void *getProcAddress(void *, const char *name) { return reinterpret_cast<void *>(glXGetProcAddressARB(reinterpret_cast<const GLubyte *>(name))); }
void showControls(bool show) {
    if (controlsVisible == show || !toolbar) return;
    controlsVisible = show;
    if (show) XMapRaised(display, toolbar); else XUnmapWindow(display, toolbar);
    layout();
}
void focus(Control target) {
    controls.focus = target;
    XSetInputFocus(display, target == Control::Video ? video : toolbar, RevertToParent, CurrentTime);
    interact();
}
void text(int x, int y, const char *label) {
    if (font && textDraw) XftDrawStringUtf8(textDraw, &textColor, font, x, y, reinterpret_cast<const FcChar8 *>(label), static_cast<int>(std::strlen(label)));
}
void paintControls() {
    if (!toolbar || !controlsVisible) return;
    XClearWindow(display, toolbar);
    XSetForeground(display, graphics, foreground);
    const int baseline = x11::pixel(57, requested.scale);
    for (auto control : {Control::Pause, Control::Dock, Control::Fullscreen, Control::Stop}) {
        const auto &rect = controls.rect(control);
        XDrawRectangle(display, toolbar, graphics, rect.x, rect.y, rect.width - 1, rect.height - 1);
        if (controls.focus == control) XDrawRectangle(display, toolbar, graphics, rect.x + 2, rect.y + 2, std::max(0, rect.width - 5), std::max(0, rect.height - 5));
        const char *label = control == Control::Pause ? playback.number("eof-reached") ? "从头重播" : playback.number("pause") ? "播放" : "暂停"
            : control == Control::Dock ? "收起" : control == Control::Fullscreen ? "退出全屏" : "停止";
        text(rect.x + x11::pixel(8, requested.scale), baseline, label);
    }
    for (auto control : {Control::Seek, Control::Volume}) {
        const auto &rect = controls.rect(control);
        const int y = rect.y + rect.height / 2;
        XDrawLine(display, toolbar, graphics, rect.x, y, rect.x + rect.width - 1, y);
        const double value = pressed == control ? draggedFraction : control == Control::Seek
            ? playback.number("time-pos") / std::max(1.0, playback.number("duration")) : playback.number("volume") / 100;
        const int x = rect.x + static_cast<int>(std::clamp(value, 0.0, 1.0) * (rect.width - 1));
        XFillRectangle(display, toolbar, graphics, x - 2, y - 6, 4, 12);
        if (controls.focus == control) XDrawRectangle(display, toolbar, graphics, rect.x, rect.y, rect.width - 1, rect.height - 1);
    }
    const int seconds = static_cast<int>(std::clamp(playback.number("time-pos"), 0.0, 359999.0));
    char position[32]; std::snprintf(position, sizeof(position), "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60);
    text(x11::pixel(496, requested.scale), baseline, position);
    XFlush(display);
}
void layout() {
    if (!parent || !video || closing) return;
    XWindowAttributes parentInfo{};
    if (!XGetWindowAttributes(display, parent, &parentInfo)) { closing = true; return; }
    const double scale = requested.scale;
    int height = x11::pixel(requested.height, scale, 1, 65535);
    const int x = x11::pixel(requested.x, scale), y = x11::pixel(requested.y, scale);
    if (toolbar) {
        const int margin = x11::pixel(20, scale, 0), barHeight = x11::pixel(76, scale, 1);
        const int width = std::max(1, parentInfo.width - 2 * margin);
        XMoveResizeWindow(display, toolbar, margin, std::max(0, parentInfo.height - barHeight - margin), width, barHeight);
        controls.layout(width, scale);
        if (presentation == "fullscreen" && controlsVisible) height = std::max(1, std::min(height, parentInfo.height - barHeight - margin - x11::pixel(8, scale) - y));
        if (!font || fontScale != scale) {
            if (font) XftFontClose(display, font);
            // Xft does not perform Chromium-style per-glyph fallback. Require
            // the Chinese control glyphs when matching the native UI font.
            const auto pattern = std::string("sans:charset=4ece 5934 91cd 64ad 653e 6682 505c 6536 8d77 9000 51fa 5168 5c4f 6b62:pixelsize=") + std::to_string(13 * scale);
            font = XftFontOpenName(display, XScreenNumberOfScreen(parentInfo.screen), pattern.c_str());
            if (!font) throw std::runtime_error("Cannot create X11 playback control font");
            fontScale = scale;
        }
    }
    XMoveResizeWindow(display, video, x, y, x11::pixel(requested.width, scale, 1, 65535), height);
    if (visible) XRaiseWindow(display, video);
    if (controlsVisible) XRaiseWindow(display, toolbar);
    XWindowAttributes actual{};
    if (XGetWindowAttributes(display, video, &actual)) { pixelWidth = actual.width; pixelHeight = actual.height; }
}
bool draw(bool newFrame) {
    if (!display || !drawable || !context || closing || !playback.alive()) return false;
    XErrors errors(display);
    if (!glXMakeContextCurrent(display, drawable, drawable, context)) return false;
    if (!playback.render(pixelWidth, pixelHeight)) return false;
    glXSwapBuffers(display, drawable); errors.check(); playback.swapped();
    XWindowAttributes parentInfo{};
    if (newFrame && XGetWindowAttributes(display, parent, &parentInfo)) playback.presented(visible && parentInfo.map_state == IsViewable);
    return true;
}
void key(XKeyEvent &event, bool repeat) {
    const KeySym code = XLookupKeysym(&event, 0);
    const bool alt = event.state & Mod1Mask, shift = event.state & ShiftMask;
    if (alt && !(event.state & (ControlMask | ShiftMask | Mod4Mask)) && (code == XK_Left || code == XK_Right)) {
        if (!repeat) queue(code == XK_Left ? "history-back" : "history-forward");
        return;
    }
    if (event.state & (Mod1Mask | ControlMask | Mod4Mask)) return;
    if (code == XK_Tab || code == XK_ISO_Left_Tab) {
        if (presentation == "fullscreen") { showControls(true); focus(controls.tab(shift || code == XK_ISO_Left_Tab, seekable())); }
        else queue(shift ? "focus-backward" : "focus-forward");
        return;
    }
    if (code == XK_Escape) { if (!repeat) queue("history-back"); return; }
    if (event.window == toolbar) {
        if (controls.focus == Control::Seek || controls.focus == Control::Volume) {
            const bool negative = code == XK_Left || code == XK_Down, positive = code == XK_Right || code == XK_Up;
            if ((negative || positive) && (controls.focus == Control::Volume || seekable()))
                queue(controls.focus == Control::Seek ? "seek-relative" : "volume-relative", (negative ? -1 : 1) * (controls.focus == Control::Seek ? shift ? 30 : 5 : 1));
        } else if (!repeat && (code == XK_space || code == XK_Return) && controls.activation()) queue(controls.activation());
        return;
    }
    if (code == XK_space && !repeat) queue("toggle-pause");
    else if ((code == XK_m || code == XK_M) && !repeat) queue("toggle-mute");
    else if ((code == XK_f || code == XK_F) && !repeat) queue("fullscreen");
    else if (code == XK_Left || code == XK_Right) queue("seek-relative", (code == XK_Left ? -1 : 1) * (shift ? 30 : 5));
}
void events() {
    if (!display || closing) return;
    for (int count = 0; count < 2048 && XPending(display); count++) {
        XEvent event{}; XNextEvent(display, &event);
        if (event.type == DestroyNotify && (event.xdestroywindow.window == parent || event.xdestroywindow.window == video)) {
            closing = true; visible = controlsVisible = false; parent = video = toolbar = None; cancelInput(); break;
        }
        if (event.type == ConfigureNotify && event.xconfigure.window == parent) layout();
        if (event.type == ConfigureNotify && event.xconfigure.window == video) { pixelWidth = event.xconfigure.width; pixelHeight = event.xconfigure.height; }
        if (event.type == Expose) { if (event.xexpose.window == video) draw(false); else paintControls(); }
        if (event.type == FocusOut) {
            Window focused; int revert; XGetInputFocus(display, &focused, &revert);
            heldKeys.clear();
            if (focused != video && focused != toolbar) { cancelInput(); controls.focus = Control::Video; }
        }
        if (event.type == KeyPress) key(event.xkey, !heldKeys.insert(event.xkey.keycode).second);
        if (event.type == KeyRelease) {
            if (!detectableRepeat && XPending(display)) {
                XEvent next{}; XPeekEvent(display, &next);
                if (next.type == KeyPress && next.xkey.keycode == event.xkey.keycode && next.xkey.time == event.xkey.time) continue;
            }
            heldKeys.erase(event.xkey.keycode);
        }
        if (event.type == MotionNotify) {
            interact();
            if (pressed == Control::Seek || pressed == Control::Volume) draggedFraction = x11::fraction(controls.rect(pressed), event.xmotion.x);
        }
        if (event.type == ButtonPress) {
            interact(); auto &button = event.xbutton;
            if (button.button == 8 || button.button == 9) { queue(button.button == 8 ? "history-back" : "history-forward"); continue; }
            if (button.button != Button1) continue;
            if (button.window == video && presentation == "fullscreen" && !controlsVisible) {
                // The click may precede the render tick which reveals controls.
                // Dispatch it in toolbar coordinates, not as a video pause.
                int x = 0, y = 0; Window child = None;
                const bool translated = XTranslateCoordinates(display, video, toolbar, button.x, button.y, &x, &y, &child);
                showControls(true);
                if (translated && controls.bounds.contains(x, y)) {
                    singleClickAt = 0; button.window = toolbar; button.x = x; button.y = y;
                }
            }
            if (button.window == toolbar) {
                pressed = controls.hit(button.x, button.y);
                if (pressed == Control::Seek && !seekable()) { pressed = Control::Empty; continue; }
                if (pressed == Control::Empty) continue;
                focus(pressed); singleClickAt = 0;
                draggedFraction = x11::fraction(controls.rect(pressed), button.x);
                if (XGrabPointer(display, toolbar, False, ButtonReleaseMask | PointerMotionMask, GrabModeAsync, GrabModeAsync, None, None, button.time) != GrabSuccess) pressed = Control::Empty;
            } else if (button.window == video) {
                focus(Control::Video);
                if (presentation == "docked") { singleClickAt = 0; queue("expand"); }
                else if (singleClickAt && now() - singleClickAt <= 300 && std::abs(button.x - clickX) < 6 * requested.scale && std::abs(button.y - clickY) < 6 * requested.scale) { singleClickAt = 0; queue("fullscreen"); }
                else { singleClickAt = now(); clickX = button.x; clickY = button.y; }
            }
        }
        if (event.type == ButtonRelease && event.xbutton.button == Button1 && pressed != Control::Empty) {
            const auto control = pressed; pressed = Control::Empty; XUngrabPointer(display, event.xbutton.time);
            if (control == Control::Seek || control == Control::Volume) queue(control == Control::Seek ? "seek" : "volume", x11::fraction(controls.rect(control), event.xbutton.x) * (control == Control::Seek ? playback.number("duration") : 100));
            else if (controls.hit(event.xbutton.x, event.xbutton.y) == control && controls.activation()) queue(controls.activation());
        }
    }
}
void destroyPlayer() {
    if (!display) return;
    requireOwner(); closing = true;
    {
        XErrors errors(display); cancelInput();
        if (video) XUnmapWindow(display, video);
        if (toolbar) XUnmapWindow(display, toolbar);
        XSync(display, False);
        if (context && !glXMakeContextCurrent(display, cleanupDrawable, cleanupDrawable, context)) throw std::runtime_error("Cannot make X11 cleanup context current");
        playback.shutdown();
        glXMakeContextCurrent(display, None, None, nullptr);
        if (textDraw) XftDrawDestroy(textDraw);
        if (font) XftFontClose(display, font);
        if (graphics) XFreeGC(display, graphics);
        if (drawable) glXDestroyWindow(display, drawable);
        if (toolbar) XDestroyWindow(display, toolbar);
        if (video) XDestroyWindow(display, video);
        if (context) glXDestroyContext(display, context);
        if (cleanupDrawable) glXDestroyPbuffer(display, cleanupDrawable);
        if (colormap) XFreeColormap(display, colormap);
        if (visual) XFree(visual);
    }
    XCloseDisplay(display); display = nullptr;
    parent = video = toolbar = drawable = cleanupDrawable = colormap = None;
    context = nullptr; visual = nullptr; textDraw = nullptr; font = nullptr; graphics = nullptr; fontScale = 0;
    visible = controlsVisible = closing = focusFullscreen = false; controls.focus = Control::Video;
    singleClickAt = 0; lastPointerX = lastPointerY = -1;
}
void updateBounds(const Bounds &rect) {
    requested = rect;
    if (requested.scale <= 0 || requested.scale > 8) throw std::runtime_error("Invalid X11 display scale");
    layout();
}
void create(Window handle, const Bounds &rect) {
    try {
        destroyPlayer();
        ownerThread = std::this_thread::get_id(); display = XOpenDisplay(nullptr);
        if (!display) throw std::runtime_error("Cannot connect to the selected X11 display");
        XErrors errors(display);
        XWindowAttributes parentInfo{};
        if (!XGetWindowAttributes(display, handle, &parentInfo) || parentInfo.c_class != InputOutput) throw std::runtime_error("Expected an existing X11 parent window");
        parent = handle; presentation = "expanded"; controls.focus = Control::Video;
        const int screen = XScreenNumberOfScreen(parentInfo.screen);
        int major = 0, minor = 0;
        if (!glXQueryVersion(display, &major, &minor) || major < 1 || (major == 1 && minor < 3)) throw std::runtime_error("GLX 1.3 is unavailable");
        const int attributes[] = {GLX_X_RENDERABLE, True, GLX_DRAWABLE_TYPE, GLX_WINDOW_BIT | GLX_PBUFFER_BIT,
            GLX_RENDER_TYPE, GLX_RGBA_BIT, GLX_DOUBLEBUFFER, True, GLX_RED_SIZE, 8, GLX_GREEN_SIZE, 8, GLX_BLUE_SIZE, 8, None};
        int configurations = 0; GLXFBConfig *available = glXChooseFBConfig(display, screen, attributes, &configurations);
        if (!available || !configurations) { if (available) XFree(available); throw std::runtime_error("No compatible X11 GLX framebuffer configuration"); }
        GLXFBConfig config = nullptr;
        // A 32-bit ARGB child can be composited as fully transparent: libmpv's
        // render target does not promise an opaque alpha channel. Choose a
        // native opaque RGB visual instead of whichever FBConfig sorts first.
        for (int i = 0; i < configurations; i++) {
            auto *candidate = glXGetVisualFromFBConfig(display, available[i]);
            if (candidate && candidate->depth == 24) { config = available[i]; visual = candidate; break; }
            if (candidate) XFree(candidate);
        }
        XFree(available);
        if (!visual) throw std::runtime_error("No X11 GLX visual");
        colormap = XCreateColormap(display, parentInfo.root, visual->visual, AllocNone);
        XSetWindowAttributes windowAttributes{}; windowAttributes.colormap = colormap; windowAttributes.border_pixel = 0;
        windowAttributes.background_pixel = 0; windowAttributes.event_mask = ExposureMask | StructureNotifyMask | KeyPressMask | KeyReleaseMask | FocusChangeMask | ButtonPressMask | ButtonReleaseMask | PointerMotionMask;
        video = XCreateWindow(display, parent, 0, 0, 1, 1, 0, visual->depth, InputOutput, visual->visual,
            CWColormap | CWBorderPixel | CWBackPixel | CWEventMask, &windowAttributes);
        const unsigned long opaque = visual->depth == 32 ? 0xff000000UL : 0;
        background = visual->visual->red_mask | visual->visual->green_mask | visual->visual->blue_mask | opaque; foreground = opaque;
        windowAttributes.background_pixel = background;
        toolbar = XCreateWindow(display, parent, 0, 0, 1, 1, 0, visual->depth, InputOutput, visual->visual,
            CWColormap | CWBorderPixel | CWBackPixel | CWEventMask, &windowAttributes);
        if (!video || !toolbar) throw std::runtime_error("Cannot create X11 playback children");
        XStoreName(display, video, "Javdex video"); XStoreName(display, toolbar, "Javdex fullscreen controls");
        XSelectInput(display, parent, StructureNotifyMask);
        Bool supported = False; XkbSetDetectableAutoRepeat(display, True, &supported); detectableRepeat = supported;
        drawable = glXCreateWindow(display, config, video, nullptr);
        const int pbuffer[] = {GLX_PBUFFER_WIDTH, 1, GLX_PBUFFER_HEIGHT, 1, None}; cleanupDrawable = glXCreatePbuffer(display, config, pbuffer);
        const auto modern = reinterpret_cast<PFNGLXCREATECONTEXTATTRIBSARBPROC>(getProcAddress(nullptr, "glXCreateContextAttribsARB"));
        if (!modern || !drawable || !cleanupDrawable) throw std::runtime_error("OpenGL context or cleanup drawable is unavailable");
        const int contextAttributes[] = {GLX_CONTEXT_MAJOR_VERSION_ARB, 3, GLX_CONTEXT_MINOR_VERSION_ARB, 2, GLX_CONTEXT_PROFILE_MASK_ARB, GLX_CONTEXT_CORE_PROFILE_BIT_ARB, None};
        context = modern(display, config, nullptr, True, contextAttributes);
        errors.check();
        if (!context || !glXMakeContextCurrent(display, drawable, drawable, context)) throw std::runtime_error("Cannot create X11 OpenGL 3.2 context");
        graphics = XCreateGC(display, toolbar, 0, nullptr);
        textDraw = XftDrawCreate(display, toolbar, visual->visual, colormap);
        if (!graphics || !textDraw) throw std::runtime_error("Cannot create X11 control drawing resources");
        textColor.pixel = foreground; textColor.color = {0, 0, 0, 65535};
        const auto *rendererName = reinterpret_cast<const char *>(glGetString(GL_RENDERER));
        const bool softwareRendering = x11::softwareRenderer(rendererName);
        updateBounds(rect); playback.initialize(getProcAddress, nullptr, softwareRendering); interact();
        errors.check();
        return;
    } catch (const std::exception &error) {
        const std::string reason = error.what();
        try { destroyPlayer(); } catch (...) { throw std::runtime_error(reason + "; X11 cleanup failed"); }
        throw std::runtime_error(reason);
    }
}
void bounds(const Bounds &rect) {
    if (display && !closing) { requireOwner(); XErrors errors(display); events(); updateBounds(rect); errors.check(); }
}
void setVisible(bool value) {
        if (display && !closing) {
            requireOwner(); XErrors errors(display); events();
            if (closing) return;
            visible = value;
            if (value) XMapRaised(display, video); else {
                Window focused; int revert; XGetInputFocus(display, &focused, &revert);
                cancelInput(); XUnmapWindow(display, video); showControls(false);
                if (focused == video || focused == toolbar) XSetInputFocus(display, parent, RevertToParent, CurrentTime);
            }
            errors.check();
        }
}
void setPresentation(const std::string &next) {
        if (display && !closing) {
            requireOwner();
            if (next != "expanded" && next != "docked" && next != "fullscreen") throw std::runtime_error("Invalid playback presentation");
            if (next == presentation) return;
            XErrors errors(display); cancelInput(); presentation = next; focusFullscreen = next == "fullscreen"; interact();
            if (next != "fullscreen") {
                Window focused; int revert; XGetInputFocus(display, &focused, &revert);
                controls.focus = Control::Video;
                if (focused == video || focused == toolbar) XSetInputFocus(display, parent, RevertToParent, CurrentTime);
            }
            showControls(next == "fullscreen" && visible); layout(); errors.check();
        }
}
std::string state() {
    if (display) { requireOwner(); { XErrors errors(display); events(); } if (closing) destroyPlayer(); }
    auto result = playback.stateJson();
    if (playback.alive()) {
        result.pop_back();
        result += ",\"pixelWidth\":" + std::to_string(pixelWidth) + ",\"pixelHeight\":" + std::to_string(pixelHeight)
            + ",\"backend\":\"x11-glx\",\"fullscreenControlsVisible\":" + (controlsVisible ? "true" : "false") + '}';
    }
    return result;
}
void render() {
        if (!display || !drawable || closing) return;
        requireOwner(); XErrors errors(display); events(); if (closing) return;
        const auto timestamp = now();
        if (singleClickAt && timestamp - singleClickAt > 300) { singleClickAt = 0; queue("toggle-pause"); }
        if (visible && presentation == "fullscreen") {
            Window root, child; int rootX, rootY, x, y; unsigned int mask;
            const bool pointer = XQueryPointer(display, parent, &root, &child, &rootX, &rootY, &x, &y, &mask);
            if (pointer && (x != lastPointerX || y != lastPointerY)) { lastPointerX = x; lastPointerY = y; interact(); }
            Window focused; int revert; XGetInputFocus(display, &focused, &revert);
            if (focusFullscreen && (focused == parent || focused == video || focused == toolbar)) { focus(Control::Video); focusFullscreen = false; }
            showControls(playback.number("pause") || pressed != Control::Empty || focused == toolbar || (pointer && child == toolbar) || timestamp - lastInteraction <= 3000);
            paintControls();
        }
        if (!glXMakeContextCurrent(display, drawable, drawable, context)) throw std::runtime_error("Cannot make X11 playback context current");
        if (playback.updateRequested() && !draw(true)) throw std::runtime_error("X11 frame rendering failed");
        errors.check();
}
} // namespace

#include "linuxPlaybackHelper.h"
