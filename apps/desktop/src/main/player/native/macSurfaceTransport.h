#pragma once
// IOSurface/Mach resource operations only; no AppKit, GL, decoder or Node.
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
namespace javdex::mac {
inline IOSurfaceRef createSurface(int width, int height) {
    const void *keys[] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat};
    const int values[] = {width, height, 4, 0x42475241}; // BGRA
    const void *numbers[4]{};
    for (int i = 0; i < 4; i++) numbers[i] = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &values[i]);
    const auto properties = CFDictionaryCreate(kCFAllocatorDefault, keys, numbers, 4,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    for (auto number : numbers) if (number) CFRelease(number);
    if (!properties) throw std::runtime_error("Cannot allocate IOSurface properties");
    const auto surface = IOSurfaceCreate(properties); CFRelease(properties);
    if (!surface) throw std::runtime_error("Cannot allocate IOSurface");
    return surface;
}
struct SurfaceMessage { mach_msg_header_t header; mach_msg_body_t body; mach_msg_port_descriptor_t surface; uint64_t sequence; };
class SurfaceChannels {
    struct Channel { mach_port_t port = MACH_PORT_NULL; std::map<uint64_t, IOSurfaceRef> waiting; };
    std::map<std::string, Channel> channels;
public:
    ~SurfaceChannels() { while (!channels.empty()) close(channels.begin()->first); }
    void open(const std::string &name) {
        if (channels.size() >= 2 || channels.count(name)) throw std::runtime_error("Playback channel budget exceeded");
        mach_port_t port = MACH_PORT_NULL;
        if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port) != KERN_SUCCESS) throw std::runtime_error("Cannot allocate playback channel");
        if (mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS
            || bootstrap_register(bootstrap_port, const_cast<char *>(name.c_str()), port) != KERN_SUCCESS) {
            mach_port_destroy(mach_task_self(), port); throw std::runtime_error("Cannot register private playback channel");
        }
        channels.emplace(name, Channel{port, {}});
    }
    void close(const std::string &name) {
        const auto found = channels.find(name);
        if (found == channels.end()) return;
        for (auto &[sequence, surface] : found->second.waiting) CFRelease(surface);
        bootstrap_register(bootstrap_port, const_cast<char *>(name.c_str()), MACH_PORT_NULL);
        mach_port_destroy(mach_task_self(), found->second.port); channels.erase(found);
    }
    static void publish(const std::string &name, uint64_t sequence, IOSurfaceRef source) {
        mach_port_t destination = MACH_PORT_NULL, surface = MACH_PORT_NULL;
        try {
            if (!sequence || sequence > 9007199254740991ULL) throw std::runtime_error("Invalid playback surface sequence");
            if (bootstrap_look_up(bootstrap_port, const_cast<char *>(name.c_str()), &destination) != KERN_SUCCESS) throw std::runtime_error("Playback channel is unavailable");
            surface = IOSurfaceCreateMachPort(source);
            if (!surface) throw std::runtime_error("Cannot export playback IOSurface");
            SurfaceMessage message{};
            message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
            message.header.msgh_size = sizeof(message); message.header.msgh_remote_port = destination;
            message.body.msgh_descriptor_count = 1; message.sequence = sequence;
            message.surface.name = surface; message.surface.disposition = MACH_MSG_TYPE_COPY_SEND; message.surface.type = MACH_MSG_PORT_DESCRIPTOR;
            if (mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(message), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL) != KERN_SUCCESS)
                throw std::runtime_error("Cannot send playback IOSurface");
        } catch (...) {
            if (surface) mach_port_deallocate(mach_task_self(), surface);
            if (destination) mach_port_deallocate(mach_task_self(), destination); throw;
        }
        mach_port_deallocate(mach_task_self(), surface); mach_port_deallocate(mach_task_self(), destination);
    }
    IOSurfaceRef acquire(const std::string &name, uint64_t sequence) {
        auto &channel = channels.at(name);
        struct { SurfaceMessage message; mach_msg_max_trailer_t trailer; } receive{};
        while (mach_msg(&receive.message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof(receive), channel.port, 0, MACH_PORT_NULL) == KERN_SUCCESS) {
            auto &m = receive.message;
            if (m.header.msgh_size != sizeof(SurfaceMessage) || !(m.header.msgh_bits & MACH_MSGH_BITS_COMPLEX)
                || m.body.msgh_descriptor_count != 1 || m.surface.type != MACH_MSG_PORT_DESCRIPTOR
                || !m.sequence || m.sequence > 9007199254740991ULL || channel.waiting.size() >= 3 || channel.waiting.count(m.sequence)) {
                mach_msg_destroy(&m.header); throw std::runtime_error("Invalid playback Mach message");
            }
            const auto surface = IOSurfaceLookupFromMachPort(m.surface.name); mach_msg_destroy(&m.header);
            if (!surface) throw std::runtime_error("Cannot import playback IOSurface");
            channel.waiting.emplace(m.sequence, surface);
        }
        const auto found = channel.waiting.find(sequence);
        if (found == channel.waiting.end()) throw std::runtime_error("Playback IOSurface was not delivered");
        const auto value = found->second; channel.waiting.erase(found); return value;
    }
};
}
