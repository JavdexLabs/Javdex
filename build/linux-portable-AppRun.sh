#!/usr/bin/env bash
set -euo pipefail
APPDIR="${APPDIR:-$(dirname "$(readlink -f "$0")")}"
export APPDIR
export XDG_DATA_DIRS="$APPDIR/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}:/usr/local/share:/usr/share"
# Only Electron's small compatibility set is global. Media libraries have their
# own $ORIGIN RUNPATH, and never alter the GPU process's driver search path.
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$APPDIR/javdex-linux-portable-phase1" --javdex-wayland "$@"
