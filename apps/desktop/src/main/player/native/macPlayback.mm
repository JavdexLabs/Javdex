// macOS native playback host. Only the main-process adapter can load this module.
#import <Cocoa/Cocoa.h>
#import <OpenGL/gl3.h>
#include "mpvCore.h"
#include "macNavigationKey.h"
#include <dlfcn.h>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

using javdex::fail;
using javdex::undefined;
using javdex::stringArg;
using javdex::setNumber;
using javdex::setString;
using javdex::setFlag;
using javdex::namedNumber;
static javdex::MpvCore playback;

@interface JavdexMpvView : NSOpenGLView {
@public
    BOOL closed;
    int pixelWidth;
    int pixelHeight;
}
- (BOOL)renderFrame;
- (BOOL)presentFrame;
@end

static JavdexMpvView *playerView;
static std::string presentation = "expanded";
static NSView *controls;
static NSButton *pauseButton;
static NSButton *dockButton;
static NSButton *fullscreenButton;
static NSButton *stopButton;
static NSSlider *seekSlider;
static NSSlider *volumeSlider;
static NSTextField *timeLabel;
static NSPoint lastMouse;
static double lastInteraction = 0;
static double singleClickAt = 0;
static NSRect requestedVideoFrame;
static bool focusFullscreen;
static __weak NSWindow *accessibilityWindow;

static void clearAccessibility() {
    // Unlike setAccessibilityChildren:nil, this removes the override and restores
    // AppKit's dynamic tree. Never leave a captured window tree after playback.
    [accessibilityWindow accessibilitySetOverrideValue:nil forAttribute:NSAccessibilityChildrenAttribute];
    accessibilityWindow = nil;
}
static void updateAccessibility() {
    clearAccessibility();
    if (!playerView || playerView.hidden || presentation != "fullscreen" || !controls) return;
    NSWindow *window = playerView.window;
    // Chromium's BridgedContentView exposes only its own accessible root, omitting
    // added NSViews. Extend the window tree, without swizzling Chromium or replacing
    // its content view. This documented legacy API is needed for reversible overrides.
    NSArray *children = window.accessibilityChildren ?: @[];
    if (![children containsObject:playerView]) children = [children arrayByAddingObject:playerView];
    if (![children containsObject:controls]) children = [children arrayByAddingObject:controls];
    playerView.accessibilityParent = window;
    controls.accessibilityParent = window;
    if ([window accessibilitySetOverrideValue:children forAttribute:NSAccessibilityChildrenAttribute]) accessibilityWindow = window;
}

static void queueAction(const char *kind, double value = 0) {
    playback.queue(kind, value);
    lastInteraction = [NSDate timeIntervalSinceReferenceDate];
}
static bool historyKey(NSView *view, NSEvent *event) {
    if (!view.window.isKeyWindow || view.window.firstResponder != view) return false;
    NSEventModifierFlags flags = event.modifierFlags;
    NSString *key = event.charactersIgnoringModifiers;
    const char *action = javdex::navigationAction(event.keyCode, key.length ? [key characterAtIndex:0] : 0,
        flags & NSEventModifierFlagCommand, flags & NSEventModifierFlagOption,
        flags & NSEventModifierFlagShift, flags & NSEventModifierFlagControl);
    if (!action) return false;
    if (!event.isARepeat) queueAction(action);
    return true;
}
static bool historyMouse(NSEvent *event) {
    if (event.buttonNumber == 3) { queueAction("history-back"); return true; }
    if (event.buttonNumber == 4) { queueAction("history-forward"); return true; }
    return false;
}
static bool navigateControls(NSView *view, NSEvent *event) {
    if (event.keyCode != 48 || (event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption))) return false;
    bool backwards = event.modifierFlags & NSEventModifierFlagShift;
    if (presentation != "fullscreen" || !controls) {
        queueAction(backwards ? "focus-backward" : "focus-forward");
        return true;
    }
    controls.hidden = NO;
    lastInteraction = [NSDate timeIntervalSinceReferenceDate];
    NSArray<NSView *> *order = @[playerView, seekSlider, pauseButton, volumeSlider, dockButton, fullscreenButton, stopButton];
    NSInteger index = [order indexOfObjectIdenticalTo:view];
    if (index == NSNotFound) index = 0;
    for (NSUInteger step = 1; step <= order.count; step++) {
        NSInteger next = (index + (backwards ? -1 : 1) * (NSInteger)step + (NSInteger)order.count) % (NSInteger)order.count;
        NSView *target = order[next];
        if ([target isKindOfClass:[NSControl class]] && ![(NSControl *)target isEnabled]) continue;
        if ([view.window makeFirstResponder:target]) {
            NSAccessibilityPostNotification(target, NSAccessibilityFocusedUIElementChangedNotification);
            break;
        }
    }
    return true;
}
@interface JavdexMpvButton : NSButton
@end
@implementation JavdexMpvButton
- (BOOL)performKeyEquivalent:(NSEvent *)event { return historyKey(self, event) || [super performKeyEquivalent:event]; }
- (void)otherMouseDown:(NSEvent *)event { if (!historyMouse(event)) [super otherMouseDown:event]; }
- (BOOL)acceptsFirstResponder { return self.enabled; }
- (BOOL)canBecomeKeyView { return self.enabled && !self.hidden; }
- (void)keyDown:(NSEvent *)event {
    if (historyKey(self, event)) return;
    if (navigateControls(self, event)) return;
    if (!(event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption))) {
        if (event.keyCode == 53) { queueAction("fullscreen"); return; }
        // AppKit's default button key handling depends on system keyboard-navigation
        // preferences. Our explicit Tab chain must also activate with Space/Return.
        if (event.keyCode == 49 || event.keyCode == 36 || event.keyCode == 76) { [self performClick:self]; return; }
    }
    [super keyDown:event];
}
@end
@interface JavdexMpvSlider : NSSlider
@end
@implementation JavdexMpvSlider
- (BOOL)performKeyEquivalent:(NSEvent *)event { return historyKey(self, event) || [super performKeyEquivalent:event]; }
- (void)otherMouseDown:(NSEvent *)event { if (!historyMouse(event)) [super otherMouseDown:event]; }
- (BOOL)acceptsFirstResponder { return self.enabled; }
- (BOOL)canBecomeKeyView { return self.enabled && !self.hidden; }
- (void)keyDown:(NSEvent *)event {
    if (historyKey(self, event)) return;
    if (navigateControls(self, event)) return;
    if (!(event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption))) {
        if (event.keyCode == 53) { queueAction("fullscreen"); return; }
        if (self.enabled && (event.keyCode == 123 || event.keyCode == 124 || event.keyCode == 125 || event.keyCode == 126)) {
            double step = self == seekSlider ? ((event.modifierFlags & NSEventModifierFlagShift) ? 30 : 5) : 1;
            bool backwards = event.keyCode == 123 || event.keyCode == 125;
            // The render tick mirrors actual mpv values; an NSControl-local absolute
            // value can be reset between repeated keys before main drains the actions.
            queueAction(self == seekSlider ? "seek-relative" : "volume-relative", backwards ? -step : step);
            return;
        }
    }
    [super keyDown:event];
}
@end
@interface JavdexMpvActions : NSObject
- (void)pause:(id)sender;
- (void)dock:(id)sender;
- (void)fullscreen:(id)sender;
- (void)stop:(id)sender;
- (void)seek:(NSSlider *)sender;
- (void)volume:(NSSlider *)sender;
@end
@implementation JavdexMpvActions
- (void)pause:(id)sender { queueAction("toggle-pause"); }
- (void)dock:(id)sender { queueAction("dock"); }
- (void)fullscreen:(id)sender { queueAction("fullscreen"); }
- (void)stop:(id)sender { queueAction("stop"); }
- (void)seek:(NSSlider *)sender { queueAction("seek", sender.doubleValue); }
- (void)volume:(NSSlider *)sender { queueAction("volume", sender.doubleValue); }
@end
static JavdexMpvActions *actionTarget;

static void *getProcAddress(void *, const char *name) {
    return dlsym(RTLD_DEFAULT, name);
}

@implementation JavdexMpvView
- (BOOL)isOpaque { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isAccessibilityElement { return presentation == "fullscreen"; }
- (NSString *)accessibilityRole { return NSAccessibilityButtonRole; }
- (NSString *)accessibilityLabel { return @"视频画面"; }
- (NSString *)accessibilityHelp { return @"空格播放或暂停，Tab 进入播放控制，Esc 退出全屏。"; }
- (BOOL)isAccessibilityFocused { return self.window.firstResponder == self; }
- (void)setAccessibilityFocused:(BOOL)focused { if (focused) [self.window makeFirstResponder:self]; }
- (BOOL)accessibilityPerformPress { queueAction("toggle-pause"); return YES; }
- (void)mouseDown:(NSEvent *)event {
    // A click can arrive before the next render tick notices pointer movement.
    // Reveal and dispatch to the real control, rather than treating that click as video pause.
    if (presentation == "fullscreen" && controls && controls.hidden) {
        controls.hidden = NO;
        lastInteraction = [NSDate timeIntervalSinceReferenceDate];
        NSPoint point = [controls.superview convertPoint:event.locationInWindow fromView:nil];
        if (NSPointInRect(point, controls.frame)) {
            NSView *target = [controls hitTest:point];
            if (target && target != controls) [target mouseDown:event];
            return;
        }
    }
    [self.window makeFirstResponder:self];
    if (presentation == "docked") { queueAction("expand"); return; }
    if (event.clickCount == 2) { singleClickAt = 0; queueAction("fullscreen"); }
    else singleClickAt = [NSDate timeIntervalSinceReferenceDate];
    lastInteraction = [NSDate timeIntervalSinceReferenceDate];
}
- (void)keyDown:(NSEvent *)event {
    if (historyKey(self, event)) return;
    if (!self.window.isKeyWindow || (event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption))) {
        [super keyDown:event];
        return;
    }
    NSString *key = event.charactersIgnoringModifiers.lowercaseString;
    if (navigateControls(self, event)) return;
    if ([key isEqualToString:@" "]) queueAction("toggle-pause");
    else if ([key isEqualToString:@"m"]) queueAction("toggle-mute");
    else if (event.keyCode == 123 || event.keyCode == 124) {
        double seconds = (event.modifierFlags & NSEventModifierFlagShift) ? 30 : 5;
        queueAction("seek-relative", event.keyCode == 123 ? -seconds : seconds);
    }
    else if ([key isEqualToString:@"f"]) queueAction("fullscreen");
    else if (event.keyCode == 53) queueAction("history-back");
    else [super keyDown:event];
}
- (BOOL)performKeyEquivalent:(NSEvent *)event { return historyKey(self, event) || [super performKeyEquivalent:event]; }
- (void)otherMouseDown:(NSEvent *)event { if (!historyMouse(event)) [super otherMouseDown:event]; }
- (void)reshape {
    [super reshape];
    [[self openGLContext] update];
}
- (BOOL)renderFrame {
    if (closed || !playback.alive()) return NO;
    [[self openGLContext] makeCurrentContext];
    NSRect pixels = [self convertRectToBacking:self.bounds];
    pixelWidth = (int)pixels.size.width;
    pixelHeight = (int)pixels.size.height;
    return playback.render(pixelWidth, pixelHeight);
}
- (BOOL)presentFrame {
    if (![self renderFrame]) return NO;
    [[self openGLContext] flushBuffer];
    playback.swapped();
    return YES;
}
- (void)drawRect:(NSRect)rect {
    (void)rect;
    [self presentFrame];
}
@end

static void layoutVideo() {
    if (!playerView) return;
    NSRect frame = requestedVideoFrame;
    if (presentation == "fullscreen" && controls && !controls.hidden) {
        // Reserve space outside the render surface, not an override of subtitle styles.
        // This also protects ASS/bitmap subtitles and restores the whole surface when controls hide.
        NSView *host = playerView.superview;
        if (host.isFlipped) {
            frame.size.height = MAX(1, MIN(NSMaxY(frame), NSMinY(controls.frame) - 8) - NSMinY(frame));
        } else {
            double bottom = MAX(NSMinY(frame), NSMaxY(controls.frame) + 8);
            frame.size.height = MAX(1, NSMaxY(frame) - bottom);
            frame.origin.y = bottom;
        }
    }
    if (NSEqualRects(playerView.frame, frame)) return;
    [playerView setFrame:frame];
    [playerView reshape];
    [playerView setNeedsDisplay:YES];
    if (playback.alive()) [playerView displayIfNeeded];
}
static void updateBounds(napi_env env, napi_value bounds) {
    NSView *host = playerView.superview;
    double x = namedNumber(env, bounds, "x");
    double y = namedNumber(env, bounds, "y");
    double width = namedNumber(env, bounds, "width");
    double height = namedNumber(env, bounds, "height");
    if (![host isFlipped]) y = host.bounds.size.height - y - height;
    requestedVideoFrame = NSMakeRect(x, y, MAX(1, width), MAX(1, height));
    if (controls) [controls setFrame:NSMakeRect(20, host.isFlipped ? host.bounds.size.height - 80 : 16, MAX(1, host.bounds.size.width - 40), 64)];
    layoutVideo();
}
static void destroyPlayer() {
    if (!playerView) return;
    playerView->closed = YES;
    [[playerView openGLContext] makeCurrentContext];
    playback.shutdown();
    [playerView removeFromSuperview];
    [controls removeFromSuperview];
    clearAccessibility();
    controls = nil; pauseButton = nil; dockButton = nil; fullscreenButton = nil; stopButton = nil;
    seekSlider = nil; volumeSlider = nil; timeLabel = nil; actionTarget = nil; focusFullscreen = false;
    singleClickAt = 0;
    [NSOpenGLContext clearCurrentContext];
    playerView = nil;
}
static void cleanup(void *) { destroyPlayer(); }

static napi_value create(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2 || ![NSThread isMainThread]) return fail(env, "create requires main thread, handle and bounds");
    destroyPlayer();
    void *data = nullptr;
    size_t size = 0;
    if (napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(void *)) {
        return fail(env, "Invalid native window handle");
    }
    void *pointer;
    std::memcpy(&pointer, data, sizeof(pointer));
    NSView *host = (__bridge NSView *)pointer;
    NSOpenGLPixelFormatAttribute attributes[] = {
        NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
        NSOpenGLPFADoubleBuffer, NSOpenGLPFAAccelerated,
        NSOpenGLPFAColorSize, 24, NSOpenGLPFAAlphaSize, 8, 0
    };
    NSOpenGLPixelFormat *format = [[NSOpenGLPixelFormat alloc] initWithAttributes:attributes];
    if (!format) return fail(env, "Cannot create native OpenGL pixel format");
    playerView = [[JavdexMpvView alloc] initWithFrame:NSMakeRect(0, 0, 640, 360) pixelFormat:format];
    [playerView setWantsBestResolutionOpenGLSurface:YES];
    [host addSubview:playerView positioned:NSWindowAbove relativeTo:nil];
    try {
        updateBounds(env, args[1]);
        [[playerView openGLContext] makeCurrentContext];
        playback.initialize(getProcAddress);
    } catch (const std::exception &error) { destroyPlayer(); return fail(env, error.what()); }
    [playerView setHidden:YES];
    return undefined(env);
}
static napi_value bounds(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    try { if (playerView && argc == 1) updateBounds(env, args[0]); }
    catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
static napi_value visible(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1]; bool value = false;
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc == 1) napi_get_value_bool(env, args[0], &value);
    if (playerView) [playerView setHidden:!value];
    if (!value && controls) [controls setHidden:YES];
    updateAccessibility();
    return undefined(env);
}
static NSButton *nativeButton(NSView *host, NSString *title, SEL selector, double x, double width) {
    NSButton *button = [JavdexMpvButton buttonWithTitle:title target:actionTarget action:selector];
    button.bezelStyle = NSBezelStyleRounded;
    button.frame = NSMakeRect(x, 6, width, 32);
    [host addSubview:button];
    return button;
}
static napi_value setPresentation(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1 || !playerView) return undefined(env);
    std::string next;
    try { next = stringArg(env, args[0]); } catch (const std::exception &error) { return fail(env, error.what()); }
    if (next != presentation) focusFullscreen = next == "fullscreen";
    presentation = next;
    lastInteraction = [NSDate timeIntervalSinceReferenceDate];
    if (presentation == "fullscreen" && !controls) {
        NSView *host = playerView.superview;
        actionTarget = [JavdexMpvActions new];
        controls = [[NSView alloc] initWithFrame:NSMakeRect(20, 16, MAX(1, host.bounds.size.width - 40), 64)];
        controls.wantsLayer = YES;
        controls.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        [controls setAccessibilityElement:YES];
        [controls setAccessibilityRole:NSAccessibilityGroupRole];
        [controls setAccessibilityLabel:@"全屏播放控制"];
        controls.layer.backgroundColor = [[NSColor colorWithWhite:0.08 alpha:0.94] CGColor];
        controls.layer.cornerRadius = 8;
        [host addSubview:controls positioned:NSWindowAbove relativeTo:playerView];
        pauseButton = nativeButton(controls, @"暂停", @selector(pause:), 8, 64);
        dockButton = nativeButton(controls, @"收起", @selector(dock:), 80, 64);
        fullscreenButton = nativeButton(controls, @"退出全屏", @selector(fullscreen:), 152, 90);
        stopButton = nativeButton(controls, @"停止", @selector(stop:), 250, 64);
        volumeSlider = [JavdexMpvSlider sliderWithValue:50 minValue:0 maxValue:100 target:actionTarget action:@selector(volume:)];
        volumeSlider.frame = NSMakeRect(330, 8, 120, 28);
        volumeSlider.continuous = NO;
        [volumeSlider setAccessibilityLabel:@"音量"];
        [controls addSubview:volumeSlider];
        timeLabel = [NSTextField labelWithString:@"00:00"];
        timeLabel.frame = NSMakeRect(464, 12, 140, 22);
        timeLabel.textColor = [NSColor whiteColor];
        [controls addSubview:timeLabel];
        seekSlider = [JavdexMpvSlider sliderWithValue:0 minValue:0 maxValue:1 target:actionTarget action:@selector(seek:)];
        seekSlider.frame = NSMakeRect(10, 40, controls.bounds.size.width - 20, 20);
        seekSlider.autoresizingMask = NSViewWidthSizable;
        seekSlider.continuous = NO;
        [seekSlider setAccessibilityLabel:@"播放进度"];
        [controls addSubview:seekSlider];
    }
    if (controls) controls.hidden = presentation != "fullscreen" || playerView.hidden;
    updateAccessibility();
    layoutVideo();
    return undefined(env);
}
static napi_value command(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (!playerView || playerView->closed) return fail(env, "No native playback session");
    if (argc != 1) return fail(env, "Expected one command array");
    try { playback.command(env, args[0]); } catch (const std::exception &error) { return fail(env, error.what()); }
    return undefined(env);
}
static napi_value readState(napi_env env, bool consume) {
    napi_value result = playback.state(env, consume);
    if (!playerView || playerView->closed || !playback.alive()) return result;
    setNumber(env, result, "pixelWidth", playerView->pixelWidth);
    setNumber(env, result, "pixelHeight", playerView->pixelHeight);
    id focused = playerView.window.firstResponder;
    const char *focusedControl = focused == playerView ? "video" : focused == pauseButton ? "pause" : focused == seekSlider ? "seek"
        : focused == volumeSlider ? "volume" : focused == dockButton ? "dock" : focused == fullscreenButton ? "fullscreen" : focused == stopButton ? "stop" : "web-content";
    setString(env, result, "focusedControl", focusedControl);
    setFlag(env, result, "fullscreenControlsVisible", controls && !controls.hidden);
    return result;
}
static napi_value state(napi_env env, napi_callback_info) { return readState(env, true); }
// Acceptance diagnostics must not steal actions or libmpv events from the main
// session's sole consumer. Not exposed through renderer IPC.
static napi_value inspect(napi_env env, napi_callback_info) { return readState(env, false); }
static napi_value capture(napi_env env, napi_callback_info) {
    if (!playerView || playerView->closed) return fail(env, "No native playback session");
    // One-shot diagnostic readback only; ordinary playback never copies frames to JS.
    if (![playerView renderFrame]) return fail(env, "Cannot capture native frame");
    int width = playerView->pixelWidth, height = playerView->pixelHeight;
    std::vector<unsigned char> rgba((size_t)width * height * 4);
    glReadBuffer(GL_BACK);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
    std::vector<unsigned char> bgra(rgba.size());
    for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
        size_t target = ((size_t)y * width + x) * 4;
        size_t source = ((size_t)(height - y - 1) * width + x) * 4;
        bgra[target] = rgba[source + 2]; bgra[target + 1] = rgba[source + 1];
        bgra[target + 2] = rgba[source]; bgra[target + 3] = 255;
    }
    [[playerView openGLContext] flushBuffer];
    playback.swapped();
    napi_value result, buffer; napi_create_object(env, &result);
    napi_create_buffer_copy(env, bgra.size(), bgra.data(), nullptr, &buffer);
    napi_set_named_property(env, result, "data", buffer);
    setNumber(env, result, "width", width); setNumber(env, result, "height", height);
    if (controls && !controls.hidden) {
        NSRect controlPixels = [playerView convertRectToBacking:[playerView convertRect:controls.bounds fromView:controls]];
        setNumber(env, result, "controlsTop", height - NSMaxY(controlPixels));
    }
    return result;
}
static napi_value render(napi_env env, napi_callback_info) {
    double now = [NSDate timeIntervalSinceReferenceDate];
    // Fullscreen animation can restore Chromium's responder after the initial
    // viewport report. Claim focus once the actual native fullscreen view is ready.
    if (focusFullscreen && playerView && !playerView.hidden && playerView.window.isKeyWindow
        && (playerView.window.styleMask & NSWindowStyleMaskFullScreen)) {
        if ([playerView.window makeFirstResponder:playerView]) {
            focusFullscreen = false;
            NSAccessibilityPostNotification(playerView, NSAccessibilityFocusedUIElementChangedNotification);
        }
    }
    if (singleClickAt > 0 && now - singleClickAt > [NSEvent doubleClickInterval]) { singleClickAt = 0; queueAction("toggle-pause"); }
    if (controls && playerView && presentation == "fullscreen" && !playerView.hidden) {
        NSPoint mouse = playerView.window.mouseLocationOutsideOfEventStream;
        if (!NSEqualPoints(mouse, lastMouse)) { lastMouse = mouse; lastInteraction = now; }
        bool focus = [playerView.window.firstResponder isKindOfClass:[NSView class]] && [(NSView *)playerView.window.firstResponder isDescendantOf:controls];
        NSPoint pointer = [controls.superview convertPoint:mouse fromView:nil];
        bool hovering = NSPointInRect(pointer, controls.frame);
        controls.hidden = !playback.number("pause") && !focus && !hovering && now - lastInteraction > 3;
        layoutVideo();
        pauseButton.title = playback.number("eof-reached") ? @"从头重播" : playback.number("pause") ? @"播放" : @"暂停";
        seekSlider.enabled = playback.number("seekable") && playback.number("duration") > 0;
        seekSlider.maxValue = MAX(1, playback.number("duration"));
        if (![seekSlider.cell isHighlighted]) seekSlider.doubleValue = playback.number("time-pos");
        if (![volumeSlider.cell isHighlighted]) volumeSlider.doubleValue = playback.number("volume");
        int seconds = MAX(0, (int)playback.number("time-pos"));
        timeLabel.stringValue = [NSString stringWithFormat:@"%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60];
    }
    if (playerView && !playerView->closed && playback.alive()) {
        [[playerView openGLContext] makeCurrentContext];
        if (playback.updateRequested()) {
            if ([playerView presentFrame]) playback.presented(!playerView.hidden);
        }
    }
    return undefined(env);
}
static napi_value destroy(napi_env env, napi_callback_info) { destroyPlayer(); return undefined(env); }
static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"create", nullptr, create, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBounds", nullptr, bounds, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setVisible", nullptr, visible, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setPresentation", nullptr, setPresentation, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"command", nullptr, command, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"state", nullptr, state, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"render", nullptr, render, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"capture", nullptr, capture, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroy", nullptr, destroy, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    napi_add_env_cleanup_hook(env, cleanup, nullptr);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
