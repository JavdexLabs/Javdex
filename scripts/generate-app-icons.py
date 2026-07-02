#!/usr/bin/env python3
"""Generate platform app icons from resources/icon.png (1024x1024)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "resources" / "icon.png"
BUILD = ROOT / "build"
PUBLIC = ROOT / "src" / "renderer" / "public"

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
PNG_SIZES = (16, 32, 48, 64, 128, 256, 512, 1024)


def ensure_source() -> Image.Image:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source icon: {SOURCE}")
    image = Image.open(SOURCE).convert("RGBA")
    if image.size != (1024, 1024):
        image = image.resize((1024, 1024), Image.Resampling.LANCZOS)
        image.save(SOURCE)
    return image


def write_ico(image: Image.Image) -> None:
    frames = [image.resize((size, size), Image.Resampling.LANCZOS) for size in ICO_SIZES]
    frames[0].save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(size, size) for size in ICO_SIZES],
        append_images=frames[1:],
    )


def write_pngs(image: Image.Image) -> None:
    for size in PNG_SIZES:
        resized = image.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(BUILD / f"icon-{size}.png", format="PNG")
    image.resize((512, 512), Image.Resampling.LANCZOS).save(BUILD / "icon.png", format="PNG")


def write_public_favicons(image: Image.Image) -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 192, 512):
        image.resize((size, size), Image.Resampling.LANCZOS).save(
            PUBLIC / f"icon-{size}.png", format="PNG"
        )
    image.resize((32, 32), Image.Resampling.LANCZOS).save(PUBLIC / "icon.png", format="PNG")


def write_icns() -> None:
    """Best-effort .icns via electron-icon-builder (cross-platform)."""
    try:
        subprocess.run(
            [
                "npx",
                "--yes",
                "electron-icon-builder",
                "--input",
                str(SOURCE),
                "--output",
                str(BUILD),
                "--flatten",
            ],
            cwd=ROOT,
            check=True,
            shell=sys.platform == "win32",
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        print(f"warning: could not generate icon.icns via electron-icon-builder: {error}", file=sys.stderr)
        return

    generated = BUILD / "icons"
    for name in ("icon.ico", "icon.icns"):
        src = generated / name
        if src.exists():
            (BUILD / name).write_bytes(src.read_bytes())


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    image = ensure_source()
    write_ico(image)
    write_pngs(image)
    write_public_favicons(image)
    write_icns()
    print("Generated app icons in build/ and src/renderer/public/")


if __name__ == "__main__":
    main()
