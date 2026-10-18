#pragma once

#include <array>
#include <cerrno>
#include <fcntl.h>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace javdex::cpu {
// Keep the default subtitle/OSD font independent of host sans-serif aliases.
// Some fontconfig providers select WOFF2 files unsupported by the runtime
// font loader. Other scripts may still use the system font fallback.
inline std::string fontDirectoryForExecutable(const std::string &executable) {
    const auto slash = executable.find_last_of('/');
    if (executable.empty() || executable.front() != '/' || slash == std::string::npos
        || slash + 1 == executable.size()) throw std::runtime_error("Cannot locate CPU frame helper");
    return executable.substr(0, slash) + "/fonts";
}
inline bool validSubtitleFont(const std::string &directory) {
    const auto path = directory + "/NotoSans-Regular.ttf";
    const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return false;
    struct stat info{}; std::array<unsigned char, 4> signature{};
    ssize_t count;
    do { count = pread(fd, signature.data(), signature.size(), 0); } while (count < 0 && errno == EINTR);
    const bool valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode)
        && info.st_size >= 12 && info.st_size <= 10 * 1024 * 1024
        && count == static_cast<ssize_t>(signature.size())
        && signature == std::array<unsigned char, 4>{0, 1, 0, 0};
    close(fd);
    return valid;
}
inline std::string subtitleFontDirectory() {
    std::array<char, 4096> path{};
    const auto count = readlink("/proc/self/exe", path.data(), path.size());
    if (count <= 0 || count >= static_cast<ssize_t>(path.size()))
        throw std::runtime_error("Cannot locate CPU frame helper");
    const auto directory = fontDirectoryForExecutable(std::string(path.data(), static_cast<size_t>(count)));
    if (!validSubtitleFont(directory)) throw std::runtime_error("CPU frame subtitle font is missing or invalid");
    return directory;
}
} // namespace javdex::cpu
