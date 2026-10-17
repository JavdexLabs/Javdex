#include "x11Controls.h"
#include <cassert>
#include <limits>

int main() {
    assert(javdex::x11::softwareRenderer("llvmpipe (LLVM 19.1.7, 256 bits)"));
    assert(javdex::x11::softwareRenderer("softpipe"));
    assert(!javdex::x11::softwareRenderer("Mesa Intel UHD Graphics"));
    assert(!javdex::x11::softwareRenderer("NVIDIA GeForce"));
    assert(!javdex::x11::softwareRenderer(nullptr));
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
    assert(pixel(1000000, 2) == 32767);
    assert(pixel(-1000000, 2) == -32768);
    assert(pixel(0, 2, 1, 65535) == 1);
    assert(pixel(std::numeric_limits<double>::infinity(), 1, 1) == 1);
    assert(pixel(10, 1.25) == 13);
}
