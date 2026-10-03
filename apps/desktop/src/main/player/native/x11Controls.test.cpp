#include "x11Controls.h"
#include <cassert>
#include <limits>

int main() {
    using namespace javdex::x11;
    uint32_t xid = 0xf1234567;
    assert(windowId(&xid, sizeof(xid)) == xid);
    for (size_t length : {size_t(0), size_t(3), size_t(8)}) {
        bool rejected = false;
        try { windowId(&xid, length); } catch (const std::runtime_error &) { rejected = true; }
        assert(rejected);
    }
    bool rejected = false; xid = 0;
    try { windowId(&xid, sizeof(xid)); } catch (const std::runtime_error &) { rejected = true; }
    assert(rejected);
    Controls controls;
    for (double scale : {1.0, 1.25, 1.5, 2.0}) {
        controls.layout(static_cast<int>(960 * scale), scale);
        assert(controls.bounds.contains(controls.dock.x, controls.dock.y));
        assert(controls.hit(controls.dock.x, controls.dock.y) == Control::Dock);
        assert(controls.bounds.contains(0, 0) && controls.hit(0, 0) == Control::Empty);
        assert(!controls.bounds.contains(controls.bounds.width, 0));
        assert(!controls.bounds.contains(0, controls.bounds.height));
        assert(controls.pause.height == static_cast<int>(32 * scale));
        assert(controls.hit(controls.pause.x, controls.pause.y) == Control::Pause);
        assert(controls.hit(controls.pause.x + controls.pause.width, controls.pause.y) == Control::Empty);
        assert(controls.hit(controls.seek.x + 1, controls.seek.y + 1) == Control::Seek);
        assert(fraction(controls.seek, -1000) == 0);
        assert(fraction(controls.seek, 100000) == 1);
        assert(fraction(controls.seek, controls.seek.x + controls.seek.width - 1) == 1);
    }
    controls.focus = Control::Video;
    assert(controls.tab(false, true) == Control::Seek);
    assert(controls.tab(false, true) == Control::Pause);
    assert(std::string(controls.activation()) == "toggle-pause");
    assert(controls.tab(true, true) == Control::Seek);
    assert(controls.activation() == nullptr);
    assert(controls.tab(true, true) == Control::Video);
    assert(controls.tab(false, false) == Control::Pause);
    controls.focus = Control::Video;
    assert(controls.tab(true, false) == Control::Stop);
    assert(std::string(controls.activation()) == "stop");
    assert(pixel(1000000, 2) == 32767);
    assert(pixel(-1000000, 2) == -32768);
    assert(pixel(0, 2, 1, 65535) == 1);
    assert(pixel(std::numeric_limits<double>::infinity(), 1, 1) == 1);
    assert(pixel(10, 1.25) == 13);
}
