#include "mpvCore.h"
#include <cassert>
#include <limits>
#ifdef NDEBUG
#error Native regressions require assertions enabled
#endif

// No GL context, Electron session or decoder required. These exercise the same
// event-copy/JSON helpers used by all native adapters, not mock implementations.
int main() {
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 2)
    assert(javdex::MpvCore::frameDelayUs(1020000000, 1000000000, false, MPV_RENDER_FRAME_INFO_PRESENT) == 20000);
    // Pause intent precedes the asynchronous mpv property observation. A stale
    // scheduled target must become an immediate redraw, never a graphics fault.
    assert(javdex::MpvCore::frameDelayUs(INT64_MAX, 1000000000, true, MPV_RENDER_FRAME_INFO_PRESENT) == 0);
    assert(javdex::MpvCore::frameDelayUs(INT64_MAX, 1000000000, false, MPV_RENDER_FRAME_INFO_PRESENT | MPV_RENDER_FRAME_INFO_REDRAW) == 0);
    assert(javdex::MpvCore::frameDelayUs(INT64_MAX, 1000000000, false, 0) == 0);
#endif
    const auto layout = javdex::frameLayout(1365.3, 767.7, 1.25);
    assert(layout.width == 1707 && layout.height == 960 && layout.stride % 64 == 0);
    assert(javdex::frameLayout(3840, 2160, 1).width == 3840);
    assert(javdex::frameLayout(8192, 8192, 1).bytes == 256ULL * 1024 * 1024);
    for (double invalid : {0.0, -1.0, 8193.0, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
        bool rejected = false;
        try { javdex::frameLayout(invalid, 1, 1); } catch (const std::runtime_error &) { rejected = true; }
        assert(rejected);
    }
    // Independent neutral-axis targets used by the real compositor acceptance:
    // encoded BT.1886 -> sRGB, ST2084/BT2390 -> 203 nit SDR, and HLG OOTF.
    assert(std::abs(javdex::color::convert({.5, .5, .5}, {})[0] * 255 - 120.4875) < .02);
    const javdex::color::Profile pq{"pq", "bt.2020", 1000};
    assert(std::abs(javdex::color::convert({javdex::color::pq(100), javdex::color::pq(100), javdex::color::pq(100)}, pq)[0] * 255 - 185.8) < .5);
    const javdex::color::Profile hlg{"hlg", "bt.2020", 1000};
    const double hlg100 = .17883277 * std::log(12 * std::pow(.1, 1 / 1.2) - .28466892) + .55991073;
    assert(std::abs(javdex::color::convert({hlg100, hlg100, hlg100}, hlg)[0] * 255 - 185.8) < .5);
    assert(javdex::color::convert({0, 0, 0}, pq)[0] == 0);
    assert(std::abs(javdex::color::pqInverse(javdex::color::pq(10000)) - 10000) < .0001);
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

    const std::string generatedHeader = "Style: Default,sans-serif,42,x\n";
    const std::string currentCue = "Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,中文\\N{\\fs34}日本語\n";
    auto timeline = javdex::parseGeneratedSubtitles(generatedHeader + currentCue);
    const auto visibleText = javdex::generatedTextAt(timeline, 5);
    timeline = javdex::parseGeneratedSubtitles(generatedHeader + currentCue
        + "Dialogue: 0,0:00:30.00,0:00:32.00,Default,,0,0,0,,未来字幕\n");
    assert(javdex::generatedTextAt(timeline, 5) == visibleText); // future generation cannot invalidate this frame
    assert(javdex::generatedTextAt(timeline, 10).empty()); // end is exclusive
    assert(javdex::generatedTextAt(timeline, 31).find("未来字幕") != std::string::npos);
    assert(javdex::generatedTextAt(timeline, 5).find("中文") != std::string::npos); // backward seek
    assert(javdex::scaleGeneratedFonts(visibleText, 0.5).find("\\fs17.") != std::string::npos);
    assert(javdex::parseGeneratedSubtitles(generatedHeader + "Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,rounded\n").cues.empty());
    bool rejected = false;
    try { javdex::parseGeneratedSubtitles(generatedHeader + "Dialogue: 0,0:00:10.00,0:00:01.00,Default,,0,0,0,,bad\n"); }
    catch (const std::exception &) { rejected = true; }
    assert(rejected);

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

    assert(javdex::optionalSubtitleCommand({"sub-add", "/fixture.ass", "select"}));
    assert(javdex::optionalSubtitleCommand({"sub-reload", "2"}));
    assert(javdex::optionalSubtitleCommand({"set", "sid", "2"}));
    assert(!javdex::optionalSubtitleCommand({"loadfile", "/fixture.mp4", "replace"}));
    assert(!javdex::optionalSubtitleCommand({"set", "pause", "yes"}));
    event = {MPV_EVENT_COMMAND_REPLY, 0, 1, nullptr};
    core.consume(event);
    assert(core.stateJson().find("\"subtitleCommandReplies\":1") != std::string::npos);
    assert(core.stateJson().find("\"subtitleCommandsPending\":0") != std::string::npos);
    event = {MPV_EVENT_COMMAND_REPLY, MPV_ERROR_COMMAND, 1, nullptr};
    core.consume(event);
    const auto subtitleFailure = core.stateJson();
    assert(subtitleFailure.find("\"subtitleCommandErrors\":1") != std::string::npos);
    assert(subtitleFailure.find("\"subtitleCommandReplies\":2") != std::string::npos);
    assert(subtitleFailure.find("\"error\":\"\"") != std::string::npos);
    assert(subtitleFailure.find("\"generatedSubtitleCommandErrors\":0") != std::string::npos);
    assert(subtitleFailure.find("\"generatedSubtitleCommandReplies\":0") != std::string::npos);
    event.reply_userdata = 2;
    core.consume(event);
    assert(core.stateJson().find("\"generatedSubtitleCommandErrors\":1") != std::string::npos);
    assert(core.stateJson().find("\"generatedSubtitleCommandReplies\":1") != std::string::npos);
    assert(core.stateJson().find("\"generatedSubtitleCommandsPending\":0") != std::string::npos);
    assert(core.stateJson().find("\"error\":\"\"") != std::string::npos);
    event.reply_userdata = 0;
    core.consume(event);
    assert(core.stateJson().find("\"error\":\"\"") == std::string::npos);
    core.shutdown(); core.shutdown(); assert(!core.alive());
}
