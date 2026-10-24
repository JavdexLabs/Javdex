#!/usr/bin/env bash
set -euo pipefail
APPDIR="${APPDIR:-$(dirname "$(readlink -f "$0")")}"
export APPDIR
export XDG_DATA_DIRS="$APPDIR/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}:/usr/local/share:/usr/share"
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Match the released AppImage launcher's user-namespace compatibility probe.
# A failed probe (including a missing unshare command) disables Chromium's
# sandbox for this launch only; it does not alter host security settings.
have_no_sandbox=0
for argument in "$@"; do
  [[ "$argument" == -- ]] && break
  if [[ "$argument" == --no-sandbox ]]; then
    have_no_sandbox=1
    break
  fi
done
if [[ "$have_no_sandbox" == 0 ]] && ! unshare -Ur true 2>/dev/null; then
  set -- --no-sandbox "$@"
fi
# Ozone must be selected on the executable command line, before Electron creates
# its native platform. Appending a switch from JS alone can be too late and give
# an X11 renderer a Wayland surface handle.
display=""
has_ozone=0
shared=0
for argument in "$@"; do
  case "$argument" in
    --) break ;;
    --javdex-x11) display=x11 ;;
    --javdex-wayland) display=wayland ;;
    --javdex-dmabuf) shared=1 ;;
    --ozone-platform|--ozone-platform=*|-ozone-platform|-ozone-platform=*) has_ozone=1 ;;
  esac
done
if [[ "$has_ozone" == 1 ]]; then exec "$APPDIR/javdex" "$@"; fi
if [[ -z "$display" ]]; then
  if [[ "$shared" == 1 || "${XDG_SESSION_TYPE:-}" == wayland || -n "${WAYLAND_DISPLAY:-}" ]]; then
    display=wayland
  else
    display=x11
  fi
  set -- "--javdex-$display" "$@"
fi
exec "$APPDIR/javdex" "--ozone-platform=$display" "$@"
