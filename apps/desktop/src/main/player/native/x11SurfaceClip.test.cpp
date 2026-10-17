#include "x11SurfaceClip.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <sstream>
#include <X11/keysym.h>

using namespace javdex::x11;
int hostFixture() {
    Display *display = XOpenDisplay(nullptr);
    assert(display);
    Window parent = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 800, 600, 0, 0, 0);
    XMapWindow(display, parent); XSetInputFocus(display, parent, RevertToParent, CurrentTime); XSync(display, False);
    std::cout << "{\"parent\":" << parent << "}" << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream input(line); std::string command; input >> command;
        Window root = None, ancestor = None, *children = nullptr; unsigned int count = 0;
        assert(XQueryTree(display, parent, &root, &ancestor, &children, &count));
        const Window video = count == 1 ? children[0] : None;
        if (children) XFree(children);
        if (command == "probe") {
            int px = 0, py = 0; input >> px >> py;
            XWarpPointer(display, None, parent, 0, 0, 0, 0, px, py); XSync(display, False);
            Window child = None, focused = None; int rootX, rootY, x, y, revert; unsigned int mask;
            assert(XQueryPointer(display, parent, &root, &child, &rootX, &rootY, &x, &y, &mask));
            XGetInputFocus(display, &focused, &revert);
            std::cout << "{\"children\":" << count << ",\"video\":" << video << ",\"hit\":" << child << ",\"focus\":" << focused << "}" << std::endl;
        } else if (command == "key") {
            std::string name; int shift = 0; input >> name >> shift;
            assert(video != None);
            XSetInputFocus(display, video, RevertToParent, CurrentTime);
            XKeyEvent event{}; event.display = display; event.window = video; event.root = DefaultRootWindow(display);
            event.same_screen = True; event.time = CurrentTime; event.keycode = XKeysymToKeycode(display, XStringToKeysym(name.c_str()));
            event.state = shift ? ShiftMask : 0;
            event.type = KeyPress; assert(XSendEvent(display, video, False, KeyPressMask, reinterpret_cast<XEvent *>(&event)));
            event.type = KeyRelease; assert(XSendEvent(display, video, False, KeyReleaseMask, reinterpret_cast<XEvent *>(&event)));
            XSync(display, False);
            std::cout << "{\"sent\":true}" << std::endl;
        } else assert(false && "unknown test host command");
    }
    XDestroyWindow(display, parent); XSync(display, False); XCloseDisplay(display);
    return 0;
}
int main(int argc, char **argv) {
    if (argc == 2 && std::strcmp(argv[1], "--host") == 0) return hostFixture();
    const std::vector<Occlusion> areas{{20, 20, 60, 60, {12, 12, 12, 12}}, {-20, 90, 50, 40, {0, 0, 0, 0}}};
    auto shape = surfaceRegion(120, 120, 0, 0, 1, areas);
    assert(XPointInRegion(shape.get(), 10, 10));
    assert(!XPointInRegion(shape.get(), 50, 50));
    assert(XPointInRegion(shape.get(), 20, 20)); // Keep native pixels at a popup's rounded corner.
    assert(!XPointInRegion(shape.get(), 32, 20));
    assert(!XPointInRegion(shape.get(), 0, 100));
    assert(XPointInRegion(shape.get(), 31, 100));
    auto scaled = surfaceRegion(240, 240, 10, 12, 2, areas);
    assert(!XPointInRegion(scaled.get(), 90, 88));
    assert(XPointInRegion(scaled.get(), 5, 5));
    auto cleared = surfaceRegion(120, 120, 0, 0, 1, {});
    assert(XPointInRegion(cleared.get(), 50, 50));
    for (const auto invalid : {Occlusion{0, 0, -1, 10, {}}, Occlusion{0, 0, 10, 10, {-1, 0, 0, 0}}}) {
        bool failed = false;
        try { surfaceRegion(120, 120, 0, 0, 1, {invalid}); } catch (const std::runtime_error &) { failed = true; }
        assert(failed);
    }
    if (argc == 2 && std::strcmp(argv[1], "--display") == 0) {
        Display *display = XOpenDisplay(nullptr);
        assert(display && "X11 surface integration requires a real test display");
        int event = 0, error = 0;
        assert(XShapeQueryExtension(display, &event, &error));
        Window parent = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 120, 120, 0, 0, 0);
        Window video = XCreateSimpleWindow(display, parent, 0, 0, 120, 120, 0, 0, 0);
        XMapWindow(display, parent); XMapWindow(display, video);
        applySurfaceRegion(display, video, shape.get()); XSync(display, False);
        for (const auto point : {std::array<int, 3>{10, 10, 1}, {50, 50, 0}, {20, 20, 1}}) {
            XWarpPointer(display, None, parent, 0, 0, 0, 0, point[0], point[1]); XSync(display, False);
            Window root = None, child = None; int rootX, rootY, x, y; unsigned int mask;
            assert(XQueryPointer(display, parent, &root, &child, &rootX, &rootY, &x, &y, &mask));
            assert((child == video) == bool(point[2]));
        }
        applySurfaceRegion(display, video, cleared.get()); XSync(display, False);
        XWarpPointer(display, None, parent, 0, 0, 0, 0, 50, 50); XSync(display, False);
        Window root = None, child = None; int rootX, rootY, x, y; unsigned int mask;
        assert(XQueryPointer(display, parent, &root, &child, &rootX, &rootY, &x, &y, &mask) && child == video);
        XDestroyWindow(display, parent); XCloseDisplay(display);
        std::cout << "X11 server applies visual/input cutouts and restores the native child\n";
    }
    std::cout << "X11 region rectangles, rounded corners, scale, clipping and invalid inputs passed\n";
}
