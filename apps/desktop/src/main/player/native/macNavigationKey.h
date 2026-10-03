#pragma once

namespace javdex {
inline const char *navigationAction(unsigned short keyCode, char16_t character, bool command, bool option, bool shift, bool control) {
    if (shift || control) return nullptr;
    if (command && !option) {
        // Match Chromium's BracketLeft/Right fallback when an input source emits
        // localized characters. These are AppKit's ANSI bracket virtual key codes.
        if (character == u'[' || keyCode == 33) return "history-back";
        if (character == u']' || keyCode == 30) return "history-forward";
    } else if (option && !command) {
        if (keyCode == 123) return "history-back";
        if (keyCode == 124) return "history-forward";
    }
    return nullptr;
}
}
