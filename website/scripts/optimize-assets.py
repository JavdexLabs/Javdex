"""Compress website assets without resizing artwork or changing its composition.

Requires Pillow: python -m pip install Pillow
Run after capture.mjs, before build.mjs.
"""

from pathlib import Path
import sys
from PIL import Image

WEBSITE = Path(__file__).resolve().parents[1]


def convert(source: Path, *, lossless: bool) -> tuple[int, int]:
    target = source.with_suffix('.webp')
    before = source.stat().st_size
    with Image.open(source) as image:
        size = image.size
        image.save(target, 'WEBP', lossless=lossless, quality=88, method=6)
    with Image.open(target) as result:
        result.load()
        if result.size != size:
            raise RuntimeError(f'Unexpected dimensions: {target}')
        if lossless:
            with Image.open(source) as original:
                if result.convert('RGBA').tobytes() != original.convert('RGBA').tobytes():
                    raise RuntimeError(f'Lossless verification failed: {target}')
    after = target.stat().st_size
    source.unlink()
    print(f'{source.name}: {before:,} -> {after:,} bytes')
    return before, after


before = after = 0
folders = [(WEBSITE / 'assets' / 'artwork', False), (WEBSITE / 'assets' / 'screenshots', True)]
if '--readme' in sys.argv:
    folders = [(WEBSITE.parent / 'docs' / 'images', True)]
for folder, lossless in folders:
    for source in sorted(folder.glob('*.png')):
        if '--readme' in sys.argv and source.stem not in ('library', 'video-detail'):
            continue
        old, new = convert(source, lossless=lossless)
        before += old
        after += new

# The website displays the app icon at 36 CSS pixels; 256px retains ample HiDPI detail.
with Image.open(WEBSITE.parent / 'build' / 'icon-1024.png') as icon:
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(
        WEBSITE / 'assets' / 'icon.png', optimize=True
    )

if before:
    print(f'Total: {before:,} -> {after:,} bytes ({(1-after/before)*100:.1f}% smaller)')
