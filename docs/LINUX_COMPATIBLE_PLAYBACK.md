# Linux GPU and CPU compatible playback

Linux x86_64 packages include two isolated helper runtimes. The existing GPU helper retains its EGL/GBM/DMA-BUF fixes. The CPU helper uses libmpv's software render API (`rgb0`), software decoding, bilinear software scaling, a 20 ms render lead for conversion/IPC, and PulseAudio protocol; its dependency closure rejects GL/EGL/GBM/DRM/VA-API imports. Electron itself still needs its normal supported Linux desktop, sandbox and graphics stack. The audio server, compositor, kernel and GPU drivers remain on the host. Ubuntu’s Pulse client also imports X11 authentication client libraries; these ordinary libraries are bundled, while the CPU helper creates no native video window and needs no GPU device. The Pulse client may use desktop audio discovery; this does not make X11 video embedding a playback requirement.

Settings → this computer → player provides Auto / GPU / CPU compatible mode, effective when reopening a video. Auto tries GPU and retries once on a native startup/render/transport failure. It does not infer failure from black pixel content or retry media format errors. CPU errors are terminal, and a new playback session may try GPU again. The playback information view shows the active mode and whether it resulted from fallback. `--javdex-cpu` explicitly chooses CPU for the process, including when GPU initialization is unavailable.

Recovery keeps the source, last observed position, pause intent, volume/mute/speed, stream selection, external subtitle files and the generated subtitle timeline. Seek recovery is bounded and remains paused until restored. Recovery uses the existing source/session, including its owned local HTTP route, rather than reopening a library resource or creating another grant. A source with no seek support cannot resume an old position. The bounded synthetic GPU import self-test described below checks its own reference pattern; it never interprets film pixels. Undetected black output still requires manual CPU selection.

At startup the CPU helper closes inherited descriptors except stdio and its private frame channel, before starting libmpv threads. The producer uses three leased, fixed-size sealed memfds. Metadata validates dimensions, stride, total size, sequence and slot ownership. The FD addon copies only descriptors it owns and validates file type, size and shrink/grow seals. FDs never reach the renderer. Private IPC copies bounded RGBA frames into the sandboxed preload's fixed canvas. An authenticated copied-frame release, separate from submission, permits slot reuse after drawing or discarding a stale frame; detach also releases copied frames. `rgb0`'s undefined alpha is normalized to 255. Canvas submission does not prove physical screen display. This CPU path includes copies and is intended for compatibility, with explicit HDR-to-SDR conversion as described below; it does not establish native HDR output, identical GPU/CPU tone curves or universal 4K/60 fps performance.

Build both pinned source profiles inside Ubuntu 22.04 with the repository's documented toolchain:

```sh
node scripts/build-playback-runtime.mjs --linux-portable
node scripts/build-playback-runtime.mjs --linux-software
python3 scripts/build-linux-angle.py /absolute/task-local/angle-build
npm run build
npx electron-builder --config electron-builder.config.mjs --linux AppImage --x64 --publish never
node scripts/check-linux-integrated-appimage.mjs dist/Javdex-0.9.0-x86_64.AppImage
```

The standard Linux x64 packaging hooks require and validate both runtimes, source bundles, ABI closure, hashes and Electron SDK identity. They stage each libmpv in a separate directory with private `$ORIGIN` paths; media libraries never become Chromium's global loader path. Preserve the adjacent source bundles whenever handing off a binary. The phase-1 AppImage/configuration is retained as a baseline. Neither CI compilation nor helper frame counts establish GUI acceptance: validate actual final-package frames, ≥60 seconds continuous playback, pause/resume, seeking, subtitles, resize/reopen and deliberate GPU failure recovery on real hardware, with an expendable profile. Record hardware, output resolution, content codec/frame rate, CPU/RSS and frame/audio timing; do not infer audio sync from a silent fixture.

## X11 direct GPU import

The packaged X11 GPU path selects ANGLE Vulkan with Chromium GaneshGL. It does not enable Chromium's separate Skia Vulkan backend. The Electron-matched ANGLE pair retains the upstream Electron security patch series and fixes `DisplayVkXcb` to honor the requested X11 visual instead of returning the root visual. The patch validates the visual against the selected X screen; it contains no machine-specific visual ID. `scripts/check-linux-angle-x11.py <runtime-directory>` exercises two real ARGB visuals and rejection of an invalid visual on a live X11 display.

The helper queries Vulkan capabilities through Electron's private loader, matches the exact DRM render device, and allocates only advertised, importable, single-plane BGRA DMA-BUF modifiers. EGL/GBM export support alone does not establish Vulkan import compatibility. No modifier or GPU model is hardcoded. Wayland retains its EGL path. Unsupported drivers/devices still use the existing explicit-error CPU recovery in Auto mode; GPU mode reports the error. This does not establish support for every Xorg server or driver.

Both GPU paths and the CPU path start with a 20 ms render lead (`video-timing-offset`). A zero lead misses deadlines even with an immediate-ACK consumer. The helpers render early without blocking their command loops and share target/timeline metadata in Linux CLOCK_MONOTONIC microseconds. The pinned mpv 0.41 implementation exports `NEXT_FRAME_INFO.target_time` in nanoseconds despite its header documenting microseconds; `MpvCore` explicitly converts that implementation's delta using `mpv_get_time_ns`. Revalidate this contract with `scripts/playback-linux-timing-smoke.cjs` when changing mpv.

The sandboxed preload calibrates its monotonic clock against main with three asynchronous round trips, using the lowest-RTT midpoint. CPU and GPU use the same target wait, requiring calibration RTT ≤20 ms within one second and rejecting targets over 100 ms ahead. Overdue frames receive no extra delay; paused/redraw frames with no target are immediate. Pause, seek, speed changes, load/stop, visibility transitions and detach/destroy invalidate old work. Waits recheck absolute time, binding, timeline and sequence. The three-slot pool bounds pending frames. This is target-time **submission**, not guaranteed scanout: Chromium/compositor latency and clock-calibration uncertainty remain. Do not equate Canvas return, requestAnimationFrame, IPC delivery or resource release with physical presentation.

Neither Linux helper calls `mpv_render_context_report_swap`: no physical swap feedback is available from this Canvas path. Hidden/backpressured skips and socket-send success are not swaps. Removing those calls corrects the feedback contract, not a demonstrated stutter fix. `submittedFrames` counts authenticated current, visible Canvas submissions; CPU release remains independent of that counter. GPU slot reuse still requires `allReferencesReleased`, with producer completion and `glFinish` retained. `auto-copy` and other native renderers' timing defaults are unchanged; zero-copy/fence optimization requires separate real-device validation.

A per-session GPU/CPU budget starts at 20 ms and estimates render-to-consumer-ready cost (excluding the intentional target wait). It uses a rolling window of up to 120 samples, p95 plus 4 ms headroom, bounded to 8–40 ms. It needs at least 30 valid timed-frame samples and changes at most once per two seconds, rising by at most 2 ms or falling by at most 1 ms, with changes smaller than 2 ms ignored. Invalid/over-100 ms costs and immediate redraws do not tune it. Timeline discontinuities reset the budget to 20 ms. These are conservative operating bounds, not universal device guarantees; validate cadence, submission timing and audible synchronization together.

`build/angle-runtime.json` pins ANGLE, Electron's patch series and depot_tools; `build/angle-args.gn` records the build configuration. The task-local build uses Chromium's downloaded Debian sysroot and toolchain, without host package or driver changes. Packaging requires the matching runtime manifest, patched library hashes, glibc baseline and corresponding source archive. Keep the ANGLE source archive alongside the GPU/CPU source archives. Rebuilding ANGLE is required when updating Electron; do not reuse a library pair from another Electron version.

ANGLE source delivery excludes downloaded directories ending in either `_sysroot` or `-sysroot`, while retaining `sysroot_scripts`, DEPS and preferred dependency sources. Its complete pinned source tree exceeds the generic archive budget, so only the nested ANGLE archive permits up to 8 GiB and 200,000 entries; other archives retain 2 GiB and 50,000 entries. All archives still reject unsafe paths, links, special files and duplicate entries before extraction. GPU receipts must include the pinned NVDEC headers. CPU receipts may omit these unused GPU-only headers because that profile disables NVDEC/CUDA; all other required pins remain mandatory. Regenerate component source recipes and the outer source inventory whenever packaging scripts change; do not reuse stale archive hashes.

## AppImage launch compatibility

The AppImage AppRun retains the released 0.9.0 launcher's `unshare -Ur true` probe. If user namespaces are unavailable (or `unshare` is missing), it adds `--no-sandbox` for that launch. An explicitly supplied `--no-sandbox` is preserved without duplication. The display/backend flags, manual CPU mode and playback recovery behavior are unchanged. This compatibility behavior disables Chromium's process sandbox for the affected launch, even though the window requests `sandbox: true`; it does not install AppArmor rules, change SUID permissions or alter global kernel settings. When the probe succeeds and the caller has not requested `--no-sandbox`, the launcher retains the sandbox. A successful Codex launch does not establish ordinary-terminal startup: verify the final AppImage from an ordinary terminal's AppArmor context as well.

## Direct AppImage startup

Linux x86_64 packaging uses electron-builder's pinned `1.0.3` toolset for compression and desktop libraries, with the runtime replaced **before** offsets, blockmaps and update hashes are computed. `build/linux-appimage-runtime.json` pins uruntime v0.8.1, its exact source commit, SquashFS lite asset size and SHA-256. Downloads are verified before execution; the package checker verifies the exact configured runtime prefix, not only the application payload. Relative toolset links remain local to the copied toolset.

The same executable first tries FUSE and automatically extracts/runs when FUSE is unavailable; users need no extra shell command or libfuse2 package. The supported embedded `URUNTIME_EXTRACT=2` policy removes the upstream 350 MiB fallback limit. `URUNTIME_UNSHARE=3` retains ordinary mounting first and drops capabilities if a namespace fallback is used. Upstream mount reuse and extraction cleanup defaults remain enabled: overlapping launches hold shared lifetime leases, cleanup waits for application descendants, and uncertain lifetime state retains files instead of deleting active data. This avoids implementing a second Javdex mount/extraction supervisor. Temporary targets may be reused briefly and are normally removed after exit; this is not a permanent extracted cache. The old external extraction scripts remain optional.

The runtime does not retry a successfully started application that later fails. Unsafe target state, an irreversible partial namespace change, extraction errors or an unwritable/non-executable temporary location can still fail with a diagnostic. No runtime can remove every desktop/driver, filesystem-permission or architecture requirement. The change installs no packages and alters no host security settings. GPU/CPU media runtimes and the AppRun sandbox-compatibility probe remain unchanged.

For startup acceptance, use a disposable profile from the ordinary-user AppArmor context. Check both a real FUSE mount and a deliberately failed mount, without passing extract-and-run flags/environment. The fixture tests use restrictions applied only to their child processes (`no_new_privs` and a seccomp denial of `unshare`) to prevent SUID mounting and namespace mounting without changing the host. Confirm that the actual final Electron homepage/API starts from an extraction target; do not treat an extracted command-line fixture alone as GUI acceptance. Playback and performance acceptance are separate.

## Unified Linux presentation

The current source has no Linux child-window/GLX adapter. X11 (including XWayland) and Wayland both select the DMA-BUF GPU helper or the CPU helper and draw into the renderer Canvas. `--javdex-x11` is a display-only alias; `--ozone-platform=x11` also uses shared frames. A legacy `x11` transport tag or nonempty native-window handle is rejected before spawning a helper. The default Linux source profile is dmabuf, and the removed X11 source files/targets are not built or packaged. Historical package/source validators may still recognize old playback-helper archives so preserved baselines remain inspectable. XWayland exercises the X11 client path but does not establish native Xorg session acceptance. Playback acceptance is separate from homepage startup.

### X11 direct-import capability gate

Before GPU playback, X11/XWayland requires the actual Chromium EGL display to advertise `EGL_EXT_image_dma_buf_import` in complete GPU information. Missing capability information is accepted only for the version-matched patched ANGLE Vulkan runtime with GPU compositing enabled; other unverified paths reject GPU creation even with a render-node override, allowing Auto to use the existing one-shot CPU fallback. The startup GPU query is bounded to five seconds so a stalled driver cannot indefinitely block the library window or CPU playback. Explicit GPU mode fails instead of silently changing its preference. This conservatively excludes Chromium's DRI3/Pixmap fallback: on the tested NVIDIA XWayland stack, that binding failed inside Skia while Canvas draw submissions still succeeded and displayed black. It may exclude other machines whose Pixmap fallback works; it is not a universal GPU health probe, and direct-import support alone does not prove visible playback. Wayland retains its existing device matching and GPU path. No media-pixel readback is enabled in normal playback.

## Validation and release boundary

The Release workflow builds both isolated helper profiles on Ubuntu 22.04 and builds or revalidates the Electron-matched patched ANGLE pair. Source download caches are separate from the Windows/macOS runtime cache; ANGLE caching includes its pinned source archive and recipe identity. Both helper builds use matching Ubuntu source repositories for their private dependency closures.

The package carries `resources/linux-playback-release.json`, binding GPU/CPU inventories, ANGLE, the launcher and AppImage runtime metadata to one Linux source companion. The normal package gate checks both ELF closures, loads both FD bridges in the packaged Electron executable and requires PCM decode EOF from each packaged libmpv. Final AppImage/DEB extraction repeats those checks and binds the final installer digests to the same source projection; AppImage also verifies the configured uruntime prefix. These headless checks do not establish GPU import, target-time presentation or audio synchronization.

The four-target source aggregator retains one public `Javdex-Playback-Sources-<version>.tar.gz`. Its Linux entry restores exact GPU, CPU and ANGLE source archives plus packaging tools. Nested verification requires preferred codec sources, Ubuntu source package checksums, matching native source/SDK, ANGLE sources and pinned patches; opaque archives or a stale helper recipe are rejected. Windows/macOS keep their existing inventories and signature rules. The migration must still complete a fresh native Release CI run before being treated as release-pipeline acceptance; no release is triggered by these local changes.

The generic CMake/Debian development compile fixture accepts older system libmpv headers; APIs older than 2.2 disable target-time metadata. The distributed runtime remains pinned to mpv 0.41 and must pass the real-helper timing check. The development fixture does not prove portable ABI or playback support.

The 2026-10-23 timing changes have Mac main/preload contract tests for 24/30/60 fps targets, clock-epoch conversion, continuous seeks, paused redraw, stale/hidden work, bounded slow consumers and cancellation/release. A Linux container compiles both helpers and the FD addon with system libmpv API 2.0 headers, runs the timing/lease tests and exercises real helper-control pipes. These checks do not exercise the pinned 0.41 target-time implementation, a native Wayland/Xorg display, physical GPU presentation or audio synchronization. Earlier hardware reviews describe their recorded packages, not acceptance of these changed helpers.

## Compatibility improvement plan (2026-10-22)

The initial inventory and local NVDEC / VA-API matrix are complete; cross-hardware coverage remains open. Follow-up work now covers hardware-decoder controls and step 2 diagnostics/recovery. Steps 3–4 remain future work:

1. Inventory the **final packaged** GPU/CPU libmpv decoders and compiled hardware APIs; test H.264, HEVC Main10 and AV1 with synthetic media. Record actual `hwdec-current` separately from GPU presentation. Establish a matrix covering Intel/AMD/NVIDIA, GNOME/KDE Wayland/native Xorg, codec/profile/resolution/frame rate and audio/subtitles. Missing hardware is pending, never a pass inferred from this workstation.
2. Improve diagnostics and bounded synthetic import self-tests. Keep decoding, display and fallback reasons distinct; do not detect black output by interpreting arbitrary film pixels. Consider version/device-scoped failure history with explicit retry.
3. Validate SDR range/BT.709, HDR10/HLG-to-SDR and GPU/CPU color consistency. Optimize CPU copies/scaling only after measuring real high-resolution workloads. Native HDR remains a separate, unproven contract.
4. Investigate decoder-to-renderer direct interop and physical presentation feedback on validated devices. Keep auto-copy as a compatibility option; do not enable display-resample without a suitable presentation feedback path or report Canvas submission as swap.

Retain unified Canvas presentation and CPU recovery. Fresh native release-pipeline validation and the AppImage sandbox fallback tradeoff remain release considerations; neither is established by local contract tests.

Step 1 tools:

```sh
# Run separately for each libmpv; never load both isolated runtimes into one process.
python3 scripts/linux-playback-capabilities.py /absolute/extracted/resources/linux-texture-experimental/libmpv.so.2
python3 scripts/linux-playback-capabilities.py /absolute/extracted/resources/linux-software-playback/libmpv.so.2
# Generate synthetic media with a task-local, caller-provided FFmpeg (no system installation).
node scripts/linux-codec-fixtures.mjs /absolute/ffmpeg /absolute/new-fixtures
node scripts/linux-codec-acceptance.mjs /absolute/Javdex.AppImage /absolute/fixtures /absolute/new-evidence wayland gpu
# Repeat with x11 gpu and wayland cpu. This runner seeds a disposable catalog.
```

The inventory queries actual packaged libmpv and its linked FFmpeg, including the compiled hardware device list. Compiled VA-API does not prove a driver/device can decode a particular stream; hardware initialization, active decoder and visible output are separate evidence. The GUI runner records package/media hashes, Chromium GPU details, per-second playback states, screenshots and end-of-run pixel checks. A successful run still requires screenshot review and does not establish human audio sync, native Xorg coverage, HDR or 4K/60 performance. Test tools/fixtures stay outside the distribution payload. Results and remaining matrix cells: [2026-10-22 codec review](reviews/linux-codec-compatibility-2026-10-22.md).

Design references: [mpv hardware decoding and auto-copy](https://mpv.io/manual/stable/#options-hwdec), [display synchronization requirements](https://mpv.io/manual/stable/#options-video-sync), [libmpv render API](https://raw.githubusercontent.com/mpv-player/mpv/v0.41.0/include/mpv/render.h). These explain the design tradeoffs; they are not acceptance evidence for Javdex.

## NVIDIA NVDEC and host VA-API driver ABI

The Linux GPU source profile now installs pinned `nv-codec-headers` 12.1.14.0 into its private build prefix and explicitly enables FFmpeg CUDA/NVDEC and mpv CUDA support. No CUDA Toolkit or NVIDIA driver is distributed. The runtime still selects `hwdec=auto-copy`: enabling mpv's CUDA interop code satisfies its OpenGL build linkage, but does not change the selected playback path to zero-copy. The CPU profile explicitly disables these features and retains its independent software-only closure.

New GPU manifests declare `driverAbi: host-vaapi-cxx-v1`. VA-API loader libraries (`libva`, `libva-drm`, `libva-x11`) and libstdc++/libgcc must come from the host alongside the vendor driver, rather than shadowing a new driver with Ubuntu 22.04's old private libraries. The CPU runtime retains its private C++ libraries. Existing manifest-v1 packages without this policy remain inspectable under their original allowlist. New-policy validation rejects bundled copies of host ABI libraries. This is scoped to the GPU helper and does not add global loader overrides or modify Chromium's environment.

Evidence motivating the boundary: on this Ubuntu 26.04 host, the old bundled libva 1.14 could not load iHD's newer `__vaDriverInit_1_22`; the installed Intel memory manager also needs `GLIBCXX_3.4.32`. Host libva/C++ enables initialization without copying host drivers into AppImage. Linux desktop driver/client libraries remain host prerequisites; Auto mode can use the independent CPU helper if GPU initialization fails.

On this UHD 770, Ubuntu's `intel-media-va-driver` Free-Kernel build decoded H.264/HEVC but lacked AV1 capability. The full-feature `intel-media-va-driver-non-free` enabled AV1. This distinction is documented by [Intel's driver feature matrix](https://github.com/intel/media-driver#media-features); do not instruct every Intel machine to install the same variant without checking hardware/distribution support. The installed packages and final-package acceptance are recorded separately from portable binary capabilities.

Local hardware/visible-frame results, installed driver versions and package hashes: [NVDEC / Intel VA-API review (2026-10-22)](reviews/linux-hardware-decode-2026-10-22.md).

## Bounded synthetic display check and recovery diagnostics

New GPU helpers receive a private `self-test` startup command and export one 640×360 fixed-color DMA-BUF before media frames. The sandboxed preload draws it through the mounted Canvas, reads five RGBA samples and clears it synchronously before returning; it does not read arbitrary video pixels. Main validates the issued sequence, current surface/binding and sender main frame, with an 8-second visible/bound timeout. Hidden time does not consume that timeout. Imports and probe buffers retain the normal release/ACK ownership rules.

The probe uses 640×360 rather than 64×64: on the tested NVIDIA/XWayland ANGLE Vulkan path, a valid 64×64 producer buffer read back with black regions, while 640×360 and normal playback sizes passed. This is a bounded startup compatibility workaround, not a repair or certification of all small-size driver imports. Partial-color results still fail validation.

This checks a small DMA-BUF import and Canvas readback. Readback can alter synchronization and Canvas behavior; a passing check does **not** certify physical scanout, every later frame, every size/modifier, or absence of driver defects. It is not a black-scene detector. Existing opt-in media pixel diagnostics remain separate and disabled by default.

Auto mode retries once with the independent CPU helper on a failed/timed-out check or a native display/channel failure. Explicit GPU mode reports failure; explicit CPU mode needs no GPU probe. Recovery preserves source position, pause intent, controls and subtitles, and now bounds the entire CPU restore to 15 seconds. Stop/reopen retries a fresh GPU session; no persistent hardware blacklist or system setting is added.

`info.playbackDiagnostics` separates current hardware/software/unknown decoding, an observed hardware-to-software decoder transition, display probe status, and a fixed allowlisted CPU fallback reason. Software decoding alone does not trigger CPU presentation fallback. An observed decoder transition is not proof of its underlying cause. The playback information panel exposes the import/Canvas check and a plain-language recovery reason; logs exclude media paths and arbitrary renderer/helper strings.

Hardware control acceptance uses `JAVDEX_CODEC_CONTROLS=1` and `JAVDEX_EXPECT_HWDEC=nvdec-copy` (or `vaapi-copy`). `JAVDEX_ACCEPTANCE_HWDEC=vaapi-copy` selects the Intel decoder in the isolated test process. Generated fixtures include a white flash and a short tone every five seconds, plus SRT captions. Inspector-based fault injection exists only in the acceptance runner (`JAVDEX_ACCEPTANCE_PROBE_FAULT=black|timeout`, `JAVDEX_ACCEPTANCE_RUNTIME_FAILURE=1`), not in application flags or production IPC.

## SDR color contract and load acceptance

The CPU helper explicitly converts decoded frames to BT.709 SDR with the pinned FFmpeg 9 `scale` filter (`out_primaries=bt709:out_transfer=bt709:out_color_matrix=bt709:intent=perceptual`) before libmpv's software viewport conversion. The legacy SW renderer's `sws_scale` conversion alone does not tone-map HDR transfer functions. This uses the existing private FFmpeg runtime and adds no GL or host library requirement. BT.709 SDR passes through without a transfer/gamut conversion. The GPU helper retains mpv's tone mapping. The two tone curves are not pixel-identical; matching them and native HDR output remain separate work.

The CPU wire contract is full-range BT.709 SDR, opaque RGBA. GPU exports ARGB8888/BGRA from libmpv without an explicit transfer/gamut tag; imported VideoFrames remain untagged. Both draw into a Canvas explicitly using its default sRGB space. This does not convert BT.709 transfer bytes to sRGB or prove GPU/CPU transfer agreement. Helper metadata and opt-in pixel diagnostics identify those contracts without changing tone-mapping parameters or enabling normal-playback readback.

Color-fixture generation tags both the raw input and encoded output and writes HEVC VUI range/primaries/transfer/matrix values. Before recording a case, it decodes the encoded file and requires the expected tags and exact lossless gray reference codes. This catches the old SDR-full fixture losing transfer/primaries with local FFmpeg 9.0.2. All four regenerated SDR/HDR cases pass that fixture check; FFmpeg 7 and final Canvas color output are not established by it. The GUI acceptance runner rejects old unvalidated manifests; generate a new directory instead of rewriting earlier evidence.

Reproducible local acceptance tools (new output directories only):

```sh
node scripts/linux-color-fixtures.mjs /absolute/ffmpeg /absolute/color-fixtures
node scripts/linux-color-acceptance.mjs /absolute/Javdex.AppImage /absolute/color-fixtures /absolute/color-evidence wayland cpu
node scripts/linux-load-fixtures.mjs /absolute/ffmpeg /absolute/load-fixtures
node scripts/linux-load-acceptance.mjs /absolute/Javdex.AppImage /absolute/media.mkv /absolute/load-evidence wayland gpu 65
```

Repeat color acceptance for `wayland` / `x11` and `gpu` / `cpu`. PQ patches use absolute luminance; HLG neutral patches assume a 1000-nit reference display with system gamma 1.2. SDR checks use analytic code values. HDR checks establish neutral ordering, useful black/white range and primary hue, not a universally correct tone curve or physical display calibration. Screenshots are taken before Canvas readback. Load tests do no pixel readback during the timed interval, record per-second process CPU ticks/RSS/FD counts and mpv drop statistics, then capture the window. These counters do not establish compositor scanout cadence or audio synchronization.

Optional `JAVDEX_ACCEPTANCE_ENV=missing-vaapi|no-gpu` uses an already installed bubblewrap to hide the host VA-API loader or GPU device nodes for a disposable process. This is a local failure-isolation experiment, not clean-distribution or physically GPU-less desktop acceptance. No host library is removed and no system setting is changed.

本机色彩矩阵、4K 吞吐边界与五分钟资源观察见 [2026-10-22 色彩与负载验收](reviews/linux-color-load-2026-10-22.md)。4K60 不能承诺满帧，GPU helper 的主要长测 RSS 增长已定位为 libmpv 0.41.0 逐帧 fence 泄漏并回移植上游修复，见 [内存调查](reviews/linux-gpu-memory-2026-10-22.md)；十分钟测试不等于数小时或跨机器保证；这些待办不由编译或截图通过替代。

For the Vulkan consumer, known NVIDIA block-linear modifiers are filtered by the actual image height before GBM allocation. Oversized blocks can import successfully but show partial black pixels on the tested NVIDIA stack; select a smaller advertised block instead of rewriting exported metadata. Normal-size frames retain the existing choice, other modifier families and the Wayland EGL path are unchanged. See [small-texture evidence](reviews/linux-small-texture-2026-10-22.md). The production synthetic self-test remains 640×360; explicit small-frame tests cover the corrected allocation policy.
