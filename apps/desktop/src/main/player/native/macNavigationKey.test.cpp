#include "macNavigationKey.h"
#include <cassert>
#include <cstring>

static void expect(const char *actual, const char *expected) {
    assert(expected ? actual && std::strcmp(actual, expected) == 0 : actual == nullptr);
}
int main() {
    using javdex::navigationAction;
    expect(navigationAction(33, u'[', true, false, false, false), "history-back");
    expect(navigationAction(30, u']', true, false, false, false), "history-forward");
    // Captured from the real Chinese input source: Command-[ reached AppKit as 【.
    expect(navigationAction(33, u'【', true, false, false, false), "history-back");
    expect(navigationAction(30, u'】', true, false, false, false), "history-forward");
    expect(navigationAction(123, 0, false, true, false, false), "history-back");
    expect(navigationAction(124, 0, false, true, false, false), "history-forward");
    expect(navigationAction(33, u'[', false, false, false, false), nullptr);
    expect(navigationAction(33, u'[', true, true, false, false), nullptr);
    expect(navigationAction(33, u'[', true, false, true, false), nullptr);
    expect(navigationAction(33, u'[', true, false, false, true), nullptr);
    expect(navigationAction(123, 0, false, true, true, false), nullptr);
    expect(navigationAction(124, 0, false, false, false, false), nullptr);
    expect(navigationAction(125, 0, false, true, false, false), nullptr);
    expect(navigationAction(49, u' ', true, false, false, false), nullptr);
}
