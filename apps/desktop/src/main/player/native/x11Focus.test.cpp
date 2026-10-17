// Exercise the real helper's private focus query and error-scope restoration.
#define main playbackHelperMain
#include "linuxX11Playback.cpp"
#undef main
#include <cassert>
#include <iostream>

int main() {
    display = XOpenDisplay(nullptr);
    assert(display && "X11 focus regression requires an isolated display");
    const auto root = DefaultRootWindow(display);
    parent = XCreateSimpleWindow(display, root, 0, 0, 100, 100, 0, 0, 0);
    Window child = XCreateSimpleWindow(display, parent, 0, 0, 50, 50, 0, 0, 0);
    Window foreign = XCreateSimpleWindow(display, root, 120, 0, 100, 100, 0, 0, 0);
    XMapWindow(display, parent); XMapWindow(display, child); XMapWindow(display, foreign);
    XSetInputFocus(display, foreign, RevertToParent, CurrentTime); XSync(display, False);
    Window previousFocus = None; int revert; XGetInputFocus(display, &previousFocus, &revert);
    assert(previousFocus == foreign);
    {
        XErrors owned(display);
        assert(parentHasFocus(parent)); assert(parentHasFocus(child)); assert(!parentHasFocus(foreign));
        owned.check();
    }
    XDestroyWindow(display, foreign); XSync(display, False);
    try {
        XErrors owned(display);
        assert(!parentHasFocus(previousFocus));
        owned.check();
    } catch (const std::exception &error) {
        std::cerr << "Dead foreign focus must not poison the playback error trap: " << error.what() << '\n';
        XDestroyWindow(display, parent); XCloseDisplay(display); display = nullptr; parent = None;
        return 1;
    }
    bool ownedFailure = false;
    try {
        XErrors owned(display);
        XWindowAttributes attributes{}; XGetWindowAttributes(display, previousFocus, &attributes);
        owned.check();
    } catch (const std::exception &) { ownedFailure = true; }
    assert(ownedFailure && "unrelated focus tolerance must not disable the owned-surface error guard");
    bool pendingFailure = false;
    try {
        XErrors owned(display);
        XResizeWindow(display, previousFocus, 40, 40); // Asynchronous error before the nested observer.
        assert(parentHasFocus(parent));
        owned.check();
    } catch (const std::exception &) { pendingFailure = true; }
    assert(pendingFailure && "pending owned errors must not be consumed by the foreign-focus observer");
    XDestroyWindow(display, parent); XCloseDisplay(display); display = nullptr; parent = None;
    std::cout << "X11 live/foreign/stale focus ancestry and owned-error guard restoration passed\n";
}
