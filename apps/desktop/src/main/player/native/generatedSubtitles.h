#pragma once
#include <algorithm>
#include <cmath>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace javdex {
constexpr size_t generatedSubtitleLimit = 8 * 1024 * 1024;
struct GeneratedCue { double start, end; std::string text; };
struct GeneratedTimeline {
    std::vector<GeneratedCue> cues;
    std::vector<double> maximumEnd;
    double fontSize = 42;
};
inline double generatedTime(const std::string &text) {
    int hours = 0, minutes = 0; double seconds = 0; char first = 0, second = 0;
    std::istringstream input(text); input.imbue(std::locale::classic());
    if (!(input >> hours >> first >> minutes >> second >> seconds) || first != ':' || second != ':'
        || input.peek() != std::char_traits<char>::eof() || hours < 0 || hours > 168 || minutes < 0 || minutes >= 60
        || !std::isfinite(seconds) || seconds < 0 || seconds >= 60) throw std::runtime_error("Invalid generated subtitle time");
    return hours * 3600.0 + minutes * 60.0 + seconds;
}
// Only the application's generated ASS dialect crosses this private seam. Parse
// into a new timeline before replacing the visible one; never clear on failure.
inline GeneratedTimeline parseGeneratedSubtitles(const std::string &document) {
    if (document.size() > generatedSubtitleLimit) throw std::runtime_error("Generated subtitles exceed limit");
    GeneratedTimeline result; std::istringstream input(document); std::string line; bool style = false;
    while (std::getline(input, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.rfind("Style: Default,sans-serif,", 0) == 0) {
            const auto start = line.find(',', line.find(',') + 1) + 1;
            const auto end = line.find(',', start); size_t used = 0;
            result.fontSize = std::stod(line.substr(start, end - start), &used);
            if (used != end - start || !std::isfinite(result.fontSize) || result.fontSize < 20 || result.fontSize > 72)
                throw std::runtime_error("Invalid generated subtitle font");
            style = true;
        }
        if (line.rfind("Dialogue: ", 0) != 0) continue;
        std::vector<std::string> fields; size_t start = 10;
        for (int index = 0; index < 9; index++) {
            const auto end = line.find(',', start);
            if (end == std::string::npos) throw std::runtime_error("Invalid generated subtitle event");
            fields.push_back(line.substr(start, end - start)); start = end + 1;
        }
        GeneratedCue cue{generatedTime(fields[1]), generatedTime(fields[2]), line.substr(start)};
        if (cue.end < cue.start || cue.end > 604800 || cue.text.size() > 32768 || result.cues.size() >= 100000
            || (!result.cues.empty() && cue.start < result.cues.back().start)) throw std::runtime_error("Invalid generated subtitle range");
        if (cue.end == cue.start) continue; // positive ASR intervals can round to the same ASS centisecond
        result.maximumEnd.push_back(std::max(cue.end, result.maximumEnd.empty() ? 0.0 : result.maximumEnd.back()));
        result.cues.push_back(std::move(cue));
    }
    if (!style) throw std::runtime_error("Missing generated subtitle style");
    return result;
}
inline std::string generatedTextAt(const GeneratedTimeline &timeline, double position) {
    if (!std::isfinite(position)) return {};
    const auto end = std::upper_bound(timeline.cues.begin(), timeline.cues.end(), position,
        [](double time, const GeneratedCue &cue) { return time < cue.start; });
    size_t index = static_cast<size_t>(end - timeline.cues.begin()); std::vector<size_t> active;
    while (index && timeline.maximumEnd[index - 1] > position) {
        --index;
        if (timeline.cues[index].end > position) active.push_back(index);
        if (active.size() > 32) throw std::runtime_error("Too many simultaneous generated subtitles");
    }
    std::string text;
    for (auto item = active.rbegin(); item != active.rend(); ++item) {
        if (!text.empty()) text += "\\N";
        text += "{\\fs" + std::to_string(timeline.fontSize) + "}" + timeline.cues[*item].text;
    }
    return text;
}
// ASS glyph sizes remain relative to the video, even when the OSD canvas also
// contains letterboxing. Only the generated numeric font overrides are scaled.
inline std::string scaleGeneratedFonts(std::string text, double scale) {
    size_t offset = 0;
    while ((offset = text.find("\\fs", offset)) != std::string::npos) {
        const auto start = offset + 3; size_t end = start;
        while (end < text.size() && ((text[end] >= '0' && text[end] <= '9') || text[end] == '.')) end++;
        if (end == start) { offset = start; continue; }
        const auto replacement = std::to_string(std::stod(text.substr(start, end - start)) * scale);
        text.replace(start, end - start, replacement); offset = start + replacement.size();
    }
    return text;
}
}
