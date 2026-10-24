#include "windowsTextureTickets.h"
#include <cassert>
#include <iostream>

int main() {
    using Pool = javdex::WindowsTextureTickets;
    Pool pool;
    pool.newGeneration();
    auto first = pool.begin(0), second = pool.begin(1), third = pool.begin(2);
    assert(pool.outstanding() == 3);
    assert(!pool.release(first)); // Producer query is not yet complete.
    bool refused = false;
    try { pool.begin(0); } catch (...) { refused = true; }
    assert(refused);
    assert(pool.complete(first)); assert(!pool.complete(first));
    pool.newGeneration(); // Destroy/create cannot reset outstanding tickets.
    assert(pool.slots[0].generation != pool.generation);
    assert(pool.release(first)); assert(!pool.release(first));
    const auto replacement = pool.begin(0);
    assert(replacement > third && replacement != first);
    assert(!pool.release(first)); assert(pool.outstanding() == 3);
    pool.quarantine(second);
    assert(!pool.complete(second)); assert(!pool.release(second));
    assert(pool.slots[1].state == Pool::State::quarantined);
    assert(pool.complete(third)); assert(pool.release(third));
    assert(pool.complete(replacement)); assert(pool.release(replacement));
    assert(pool.outstanding() == 1); // Timeout is not a synthesized GPU release.
    std::cout << "Windows export ticket lifecycle PASS (host-independent)\n";
}
