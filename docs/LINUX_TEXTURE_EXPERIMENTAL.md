# Linux shared-texture experimental AppImage

This is an opt-in engineering build for Linux x86_64 Wayland GPU testing. It is not a production release or evidence of successful hardware playback. The normal release build configuration and playback inventory gates remain unchanged.

## Isolation and invocation

The experimental package is version `0.9.1-linux-texture.1`, has the package marker `javdexExperimentalLinux: true`, uses its own `Javdex-Linux-Texture-Experimental` user-data directory, and disables application update checks. Do not point `JAVDEX_TEST_USER_DATA` at a production profile. Use an expendable media library or a backup copy for testing.

Start with `--javdex-wayland` in a native Wayland desktop, or use `--javdex-x11 --javdex-dmabuf` to isolate shared-texture testing from native Wayland windowing. `--javdex-x11` alone retains the original X11 backend. See [the host test checklist](LINUX_SHARED_TEXTURE_EXPERIMENT.md). The shared-texture backend requires a usable DRM render node, GBM/EGL DMA-BUF allocation and export, and Electron shared-texture import. Unsupported capability checks must fail explicitly; they are not permission to disable Chromium sandboxing or silently claim a software fallback is a GPU result.

## Build

Use the repository's ordinary `npm ci` and `npm run setup:desktop`. Prerequisites are CMake 3.20+, a C++17 compiler, make or Ninja, pkg-config, Electron 43.8.0 headers, exact libmpv 0.41.0 headers/library, and X11/GL/EGL/GBM/DRM development packages. Host GPU/driver libraries remain host dependencies and are not copied into the package. The experimental AppImage supplies a minimal launcher and empty desktop-entry arguments so electron-builder cannot silently disable the Electron sandbox when user namespaces are unavailable; it must fail visibly on an unsupported sandbox environment.

Configure the native source with the ordinary inputs and the additional opt-in flag:

```
cmake -S apps/desktop/src/main/player/native -B out/native-playback-build \
  -DCMAKE_BUILD_TYPE=Release \
  -DELECTRON_INCLUDE_DIR="$JAVDEX_ELECTRON_HEADERS" \
  -DMPV_PREFIX="$JAVDEX_MPV_PREFIX" \
  -DPLAYBACK_OUTPUT_DIR="$PWD/out/native-playback" \
  -DJAVDEX_BUILD_LINUX_DMABUF=ON \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON '-DCMAKE_INSTALL_RPATH=$ORIGIN'
cmake --build out/native-playback-build --parallel
```

Supply the complete reviewed Linux runtime and its corresponding source material under `$JAVDEX_PLAYBACK_RUNTIME_DIR/linux-x64`, then run:

```
node scripts/build-wayland-experimental.mjs
```

This builds production JavaScript bundles and a local AppImage, with `--publish never`. It does not create a tag, release, pull request, or upload. `--skip-build` is available only when the JavaScript bundles were already rebuilt from the current source. The ordinary release hooks validate and stage the original `native-playback` runtime. The new helper and the N-API FD bridge are separately audited and staged under `resources/linux-texture-experimental`, with an identical copy of the reviewed libmpv. Their manifest records file hashes, dependencies, GLIBC/GLIBCXX requirements and source binding.

Output is under `dist/wayland-experimental/`. Deliver the AppImage with both the ordinary playback source archive and `Javdex-Linux-Texture-Experimental-Sources-*.tar.gz`; do not distribute the binary alone. The experimental source archive contains the complete current application source, native sources/build scripts and the exact reviewed libmpv/FFmpeg third-party source archives, recipes and notices.

## Validation boundaries

Check the package manifests, the actual AppImage contents, N-API FD transport and rejection behavior, and the unchanged packaged libmpv PCM decode smoke. GPU validation requires the user's real Linux Wayland host. The build environment used during development has no `/dev/dri` device, so software EGL capability strings cannot establish DMA-BUF allocation, import, visible video, synchronization, hardware decode, or performance.

The runtime manifest reports actual native GLIBC and GLIBCXX requirements. A build on a recent distribution is not automatically compatible with older Linux installations. The reviewed codec runtime used in this experiment was built separately and requires at most GLIBC 2.35, but the new helper/addon must also be checked after each build.

## Reviewed codec provenance for this build

The unchanged codec runtime and original X11 helper were extracted from the official [Javdex v0.9.0 Linux package](https://github.com/JavdexLabs/Javdex/releases/download/v0.9.0/Javdex-0.9.0-amd64.deb), then reunited with the exact full input materials restored from the official [corresponding source archive](https://github.com/JavdexLabs/Javdex/releases/download/v0.9.0/Javdex-Playback-Sources-0.9.0.tar.gz). Both download hashes were checked against GitHub's release asset metadata before extraction. The reconstructed input passed the existing unmodified runtime validator.

- Linux package SHA-256: `e682e1ba08bc25a769fe77e30f88ca446661ce332592e3fe1293a7769e42cc4c`
- Combined upstream source archive SHA-256: `bc3a6d34ccde853313970c0ea4c9c6173426d4ac65b5ef4a43a213b7796bbf35`
- Reviewed `libmpv.so.2` SHA-256: `15f1caf505ba8fe568a1203965f8bc69704d8e28f79d36ab8083cf1632822b44`

This provenance applies to the exact downloaded bytes, not to any future replacement of the same release URL. The experimental helper/addon are independently built from this branch and have their own recorded hashes.
