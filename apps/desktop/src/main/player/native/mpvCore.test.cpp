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

    const std::string generatedHeader = "Style: Default,Microsoft YaHei,42,x\n";
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
    core.queue("seek-relative", -5);
    const auto transport = core.stateJson();
    assert(transport.find("\"actions\":[{\"kind\":\"seek-relative\",\"value\":-5.000000}]") != std::string::npos);
    assert(core.stateJson().find("\"actions\":[]") != std::string::npos);
    assert(transport.find("\"time-pos\":null") == std::string::npos); // invalidated value omitted
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
    // Old restarts and even a completed media command cannot establish new
    // frame provenance until its subsequent timeline transition has restarted.
    constexpr uint64_t mediaTag = uint64_t(1) << 63;
    javdex::MpvCore timelineCore;
    timelineCore.consume({MPV_EVENT_START_FILE, 0, 0, nullptr});
    timelineCore.consume({MPV_EVENT_PLAYBACK_RESTART, 0, 0, nullptr});
    assert(!timelineCore.mediaCommandReady(1));
    timelineCore.consume({MPV_EVENT_COMMAND_REPLY, 0, mediaTag | 1, nullptr});
    timelineCore.consume({MPV_EVENT_PLAYBACK_RESTART, 0, 0, nullptr});
    assert(!timelineCore.mediaCommandReady(1));
    timelineCore.consume({MPV_EVENT_SEEK, 0, 0, nullptr});
    assert(!timelineCore.mediaCommandReady(1));
    timelineCore.consume({MPV_EVENT_PLAYBACK_RESTART, 0, 0, nullptr});
    assert(timelineCore.mediaCommandReady(1)); assert(!timelineCore.mediaCommandReady(2));
    timelineCore.consume({MPV_EVENT_COMMAND_REPLY, 0, mediaTag | 2, nullptr});
    assert(!timelineCore.mediaCommandReady(2));
    timelineCore.consume({MPV_EVENT_START_FILE, 0, 0, nullptr});
    timelineCore.consume({MPV_EVENT_PLAYBACK_RESTART, 0, 0, nullptr});
    assert(timelineCore.mediaCommandReady(2));
    core.shutdown(); core.shutdown(); assert(!core.alive());
}
