#include "linuxFrameTiming.h"
#include <cassert>

int main() {
    javdex::LinuxFrameTiming timing;
    timing.sample(1000000, 41667); assert(timing.targetTimeUs == 1041667); // 24fps
    timing.sample(2000000, 33333); assert(timing.targetTimeUs == 2033333); // 30fps
    timing.sample(3000000, 16667); assert(timing.targetTimeUs == 3016667); // 60fps
    timing.sample(3000000, -1000); assert(timing.targetTimeUs == 2999000); // late: no extra wait
    timing.reset(1); assert(timing.targetTimeUs == 0); // paused seek flush
    timing.sample(4000000, 0); assert(timing.targetTimeUs == 0); // paused redraw
    timing.reset(2); timing.reset(3); // continuous seeks keep only newest epoch
    timing.sample(5000000, 20000);
    assert(timing.metadata() == ",\"timeline\":3,\"targetTimeUs\":5020000,\"renderStartUs\":5000000");
    bool rejected = false;
    try { timing.reset(2); } catch (...) { rejected = true; }
    assert(rejected);
    rejected = false;
    try { timing.sample(100, -101); } catch (...) { rejected = true; }
    assert(rejected);
}
