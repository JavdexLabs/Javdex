#!/usr/bin/env bash
# Experimental launcher deliberately preserves Electron's default sandbox.
set -euo pipefail
if [[ -z "${APPDIR:-}" ]]; then
  APPDIR="$(dirname "$(readlink -f "$0")")"
fi
export APPDIR
export PATH="$APPDIR${PATH:+:$PATH}"
export XDG_DATA_DIRS="$APPDIR/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}:/usr/local/share:/usr/share"
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$APPDIR/javdex-linux-texture-experimental" "$@"
