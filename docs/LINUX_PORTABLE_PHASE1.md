# Linux portable playback, phase 1

Local engineering target for Linux x86_64. The original X11 release runtime and the previous Wayland test packages stay independent. This target uses the existing DMA-BUF fixes and requires a native Wayland desktop; there is no CPU-frame fallback in this phase.

Build the pinned source graph inside Ubuntu 22.04 (glibc 2.35), with Node matching `build/playback-sources.json`, the repository npm dependencies, and C++17, CMake, make, nasm, patchelf, Python venv, pkg-config, Fontconfig/PulseAudio/VA-API/EGL/GBM/DRM/OpenGL development packages. Enable matching Ubuntu deb-src repositories for corresponding source delivery. The host needs no compiler or development headers to run the resulting package.

```
node scripts/build-playback-runtime.mjs --linux-portable
```

This builds private static FFmpeg/libass/etc. into shared libmpv. mpv's native X11/GLX output and ALSA output are disabled. Plain OpenGL render API, VA-API DRM and the PulseAudio client are enabled. PulseAudio client protocol also connects to a PipeWire PulseAudio compatibility server. The audio server itself remains on the host.

The dedicated helper is compiled directly against EGL/GBM/DRM, with the existing GPU selection and modifier fixes. Its ordinary font/audio/C++ dependency closure is copied from the baseline, recursively inspected and given private `$ORIGIN` search paths. The loader does not inject this library directory into Electron/Chromium. Fontconfig uses a bundled configuration, DejaVu Sans fallback and host/user font directories. Additional scripts require suitable fonts available in the configured directories.

Core OpenGL functions are obtained from the active EGL implementation, removing the separate libOpenGL dependency. EGL and GL dispatch remain paired with the host graphics stack. The explicit host interface set is in `scripts/linux-portable-runtime.mjs`: glibc/loader, GL/EGL dispatch, GBM and DRM. Vendor GPU implementations, VA-API driver modules, the kernel, Wayland compositor, sandbox prerequisites and audio service remain host responsibilities. Electron also requires a supported desktop environment (GTK/NSS and its usual Linux runtime baseline); this phase does not make an arbitrary minimal Linux installation a supported desktop. VA-API driver loading is dynamic and cannot be established by `DT_NEEDED` checks alone.

The closure validator rejects missing/unlisted files, digest mismatches, architecture mismatches, newer glibc requirements, private-path escapes, unaccounted libraries, unexpected dependency names and packaged vendor drivers. Each copied distribution library has package/version/source identity and copyright. The adjacent corresponding source archive contains the pinned codec sources, exact Ubuntu source packages, native SDK headers, current application sources and recipes. Source delivery must accompany any binary handoff.

Copy the generated `out/linux-portable-runtime` from the isolated build to this checkout without overwriting any old runtime. Build JavaScript and the separate AppImage:

```
npm run build
npx electron-builder --config electron-builder.linux-portable.config.mjs --linux AppImage --x64 --publish never
node scripts/check-linux-portable-appimage.mjs dist/linux-portable-phase1/Javdex-Linux-Portable-Phase1-0.9.1-linux-portable.1-x86_64.AppImage
```

This configuration uses existing verified N-API production dependencies without rebuilding them; verify their actual load in the final Electron process. This configuration overrides the integrated packaging hooks for the preserved phase-1 baseline; current standard Linux packaging is documented in LINUX_COMPATIBLE_PLAYBACK.md. The test package carries the experimental package marker and isolated profile behavior, and disables update checks. Its AppRun selects `--javdex-wayland`, preserves the Chromium sandbox, and only exposes Electron's compatibility directory globally.

Acceptance requires the actual extracted AppImage payload, source/hash/ELF checks, decode/load tests in the baseline, and visible playback on physical hardware. A clean chroot validates loader closure; it cannot prove compositor import, visible frames, hardware decoding or audio synchronization. Use an expendable profile; verify at least 60 seconds of visible playback, pause/resume, seek, subtitles, resize and reopening. A silent fixture cannot establish audio synchronization. Record separate evidence for other distributions/GPU drivers; a successful local test does not establish universal Linux compatibility.
