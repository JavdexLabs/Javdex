#include "sliderFeedback.h"
#include <cassert>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#endif

int main() {
    using javdex::sliderPositionAt;
    assert(sliderPositionAt(25, 0, 100, 0, 10000) == 2500);
    assert(sliderPositionAt(75, 0, 100, 0, 100) == 75);
    assert(sliderPositionAt(50, 0, 100, 20, 80) == 50);
    assert(sliderPositionAt(-20, 10, 110, 0, 100) == 0);
    assert(sliderPositionAt(200, 10, 110, 0, 100) == 100);
    assert(sliderPositionAt(50, 10, 10, 0, 100) == 0);
#ifdef _WIN32
    // An isolated hidden control checks pixel mapping against Win32's real
    // thumb geometry. It does not automate or validate the user's app input.
    INITCOMMONCONTROLSEX init{sizeof(init), ICC_BAR_CLASSES};
    assert(InitCommonControlsEx(&init));
    HWND host = CreateWindowW(L"STATIC", L"", WS_OVERLAPPED, 0, 0, 500, 100, nullptr, nullptr, nullptr, nullptr);
    assert(host);
    HWND slider = CreateWindowW(TRACKBAR_CLASSW, L"", WS_CHILD | TBS_NOTICKS, 0, 0, 400, 40, host, nullptr, nullptr, nullptr);
    assert(slider);
    for (int maximum : {100, 10000}) {
        SendMessageW(slider, TBM_SETRANGEMAX, FALSE, maximum);
        RECT channel{};
        SendMessageW(slider, TBM_GETCHANNELRECT, 0, reinterpret_cast<LPARAM>(&channel));
        assert(channel.right > channel.left);
        for (int percent : {0, 25, 50, 75, 100}) {
            const int position = maximum * percent / 100;
            SendMessageW(slider, TBM_SETPOS, TRUE, position);
            RECT thumb{};
            SendMessageW(slider, TBM_GETTHUMBRECT, 0, reinterpret_cast<LPARAM>(&thumb));
            const double halfThumb = (thumb.right - thumb.left) / 2.0;
            const double start = channel.left + halfThumb, end = channel.right - halfThumb;
            const double pixelStep = static_cast<double>(maximum) / (end - start);
            const int clicked = sliderPositionAt((thumb.left + thumb.right) / 2.0, start, end, 0, maximum);
            assert(std::abs(clicked - position) <= pixelStep + 1);
        }
    }
    DestroyWindow(host);
#endif
    javdex::SliderFeedback seek(1.0, 20000), volume(0.01, 5000);
    assert(seek.value(12, false, 1000) == 12);
    seek.request(60, 1000);
    volume.request(75, 1000);
    // Mouse-up releases capture before queued commands and property events.
    assert(seek.value(12, false, 1100) == 60);
    assert(volume.value(50, false, 1100) == 75);
    assert(seek.value(60, true, 1200) == 60);
    assert(seek.value(12, true, 1300) == 60);
    assert(volume.value(75, false, 1200) == 75);
    assert(volume.value(76, false, 1300) == 76);
    // A newer drag must not be overwritten by the previous command's reply.
    seek.request(90, 1400);
    assert(seek.value(60, false, 1500) == 90);
    assert(seek.value(90.25, false, 1600) == 90.25);
    assert(seek.value(91.5, false, 1700) == 91.5);
    seek.request(20, 1800);
    assert(seek.value(91.5, false, 1900) == 20);
    assert(seek.value(20, false, 2000) == 20);
    assert(seek.value(21.5, false, 2100) == 21.5);
    // Missing acknowledgement and teardown cannot pin a stale preview forever.
    volume.request(0, 2200);
    assert(volume.value(50, false, 7199) == 0);
    assert(volume.value(50, false, 7200) == 50);
    seek.request(60, 2200);
    seek.reset();
    assert(seek.value(0, false, 2300) == 0);
}
