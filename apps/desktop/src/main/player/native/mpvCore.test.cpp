#include "mpvCore.h"
#include <cassert>
#include <limits>
#ifdef NDEBUG
#error Native regressions require assertions enabled
#endif

// No GL context, Electron session or decoder required. These exercise the same
// event-copy/JSON helpers used by all native adapters, not mock implementations.
int main() {
    using javdex::nodeJson;
    assert(javdex::jsonString(nullptr) == "\"\"");
    assert(javdex::jsonString("字幕\"\\\n\t\x01") == "\"字幕\\\"\\\\\\u000a\\u0009\\u0001\"");
    mpv_node value{};
    assert(nodeJson(value) == "null");
    value.format = MPV_FORMAT_DOUBLE;
    value.u.double_ = 0.125; assert(nodeJson(value) == "0.125");
    value.u.double_ = std::numeric_limits<double>::infinity(); assert(nodeJson(value) == "null");
    value.u.double_ = std::numeric_limits<double>::quiet_NaN(); assert(nodeJson(value) == "null");
    value.format = MPV_FORMAT_INT64; value.u.int64 = 9223372036854775807LL;
    assert(nodeJson(value) == "9223372036854775807");
    value.format = MPV_FORMAT_FLAG; value.u.flag = 1; assert(nodeJson(value) == "true");
    value.u.flag = 0; assert(nodeJson(value) == "false");

    char title[] = "Second\n字幕";
    mpv_node children[2]{};
    children[0].format = MPV_FORMAT_STRING; children[0].u.string = title;
    children[1].format = MPV_FORMAT_DOUBLE; children[1].u.double_ = 12.25;
    char titleKey[] = "title", timeKey[] = "time";
    char *keys[] = {titleKey, timeKey};
    mpv_node_list list{2, children, keys};
    value.format = MPV_FORMAT_NODE_MAP; value.u.list = &list;
    const auto copied = nodeJson(value);
    assert(copied == "{\"title\":\"Second\\u000a字幕\",\"time\":12.25}");
    title[0] = 'X'; children[1].u.double_ = 0;
    assert(copied == "{\"title\":\"Second\\u000a字幕\",\"time\":12.25}");
    value.format = MPV_FORMAT_NODE_ARRAY;
    assert(nodeJson(value) == "[\"Xecond\\u000a字幕\",0]");
    value.u.list = nullptr; assert(nodeJson(value) == "[]");
    value.format = MPV_FORMAT_NODE_MAP; assert(nodeJson(value) == "{}");

    javdex::MpvCore core;
    assert(!core.alive()); assert(core.number("time-pos") == 0);
    double position = 12.25;
    mpv_event_property property{"time-pos", MPV_FORMAT_DOUBLE, &position};
    mpv_event event{MPV_EVENT_PROPERTY_CHANGE, 0, 0, &property};
    core.consume(event);
    position = 99; assert(core.number("time-pos") == 12.25); // copied before next event
    position = std::numeric_limits<double>::quiet_NaN();
    core.consume(event); assert(core.number("time-pos") == 0); // native widgets never receive NaN
    property.format = MPV_FORMAT_NONE; property.data = nullptr;
    core.consume(event); assert(core.number("time-pos") == 0); // invalidation clears stale time
    int pause = 1; property = {"pause", MPV_FORMAT_FLAG, &pause};
    core.consume(event); pause = 0; assert(core.number("pause") == 1);
    core.consume(event); assert(core.number("pause") == 0);
    event = {MPV_EVENT_FILE_LOADED, 0, 0, nullptr};
    core.consume(event); core.consume(event); assert(core.loads() == 2);
    assert(!core.updateRequested()); assert(!core.render(0, 0));
    core.shutdown(); core.shutdown(); assert(!core.alive());
}
