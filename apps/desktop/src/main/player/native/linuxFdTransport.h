#pragma once

#include <cstddef>
#include <cstdint>

// Private, local Linux experiment protocol. Frames are an opaque metadata
// packet (1..4096 bytes) with exactly one SCM_RIGHTS descriptor. This framing
// does not establish that the descriptor is a real GPU DMA-BUF.
namespace javdex_transport {
constexpr std::size_t kMaxMetadata = 4096;
constexpr std::size_t kMaxReceivedDescriptors = 16;
constexpr std::size_t kAckBytes = 16;

inline void EncodeAck(std::uint8_t* out, std::uint64_t sequence) {
  out[0] = 'J'; out[1] = 'X'; out[2] = 'A'; out[3] = 'K';
  out[4] = 1; out[5] = 0; out[6] = 0; out[7] = 0;
  for (unsigned i = 0; i < 8; ++i) out[8 + i] = (sequence >> (8 * i)) & 0xff;
}

inline bool DecodeAck(const std::uint8_t* bytes, std::size_t size,
                      std::uint64_t* sequence) {
  if (size != kAckBytes || bytes[0] != 'J' || bytes[1] != 'X' ||
      bytes[2] != 'A' || bytes[3] != 'K' || bytes[4] != 1 ||
      bytes[5] != 0 || bytes[6] != 0 || bytes[7] != 0) return false;
  *sequence = 0;
  for (unsigned i = 0; i < 8; ++i) *sequence |= std::uint64_t(bytes[8 + i]) << (8 * i);
  return true;
}
}  // namespace javdex_transport
