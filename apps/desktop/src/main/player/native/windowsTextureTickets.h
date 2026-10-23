#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace javdex {
// Process-wide export quota, including old generations and quarantined copies.
// This module contains no driver assumptions; completion is supplied by GetData,
// release only by the importing bridge's allReferencesReleased callback.
class WindowsTextureTickets {
public:
    enum class State { free, producing, exported, quarantined };
    struct Ticket { uint64_t sequence = 0, generation = 0; State state = State::free; };
    std::array<Ticket, 3> slots{};
    uint64_t generation = 0, sequence = 0;
    void newGeneration() { ++generation; }
    uint64_t begin(size_t slot) {
        auto &ticket = slots.at(slot);
        if (ticket.state != State::free) throw std::runtime_error("Texture ticket is still owned");
        if (sequence >= 9007199254740991ULL) throw std::runtime_error("Texture sequence exhausted");
        ticket = {++sequence, generation, State::producing};
        return sequence;
    }
    bool complete(uint64_t id) {
        for (auto &ticket : slots) if (ticket.sequence == id && ticket.state == State::producing) {
            ticket.state = State::exported; return true;
        }
        return false;
    }
    bool release(uint64_t id) {
        for (auto &ticket : slots) if (ticket.sequence == id && ticket.state == State::exported) {
            ticket = {}; return true;
        }
        return false;
    }
    void quarantine(uint64_t id) {
        for (auto &ticket : slots) if (ticket.sequence == id && ticket.state == State::producing)
            ticket.state = State::quarantined;
    }
    size_t outstanding() const {
        size_t count = 0;
        for (const auto &ticket : slots) if (ticket.state != State::free) ++count;
        return count;
    }
};
}
