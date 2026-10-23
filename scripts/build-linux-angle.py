#!/usr/bin/env python3
"""Build the Electron-matched ANGLE pair without modifying host packages.

Usage: python3 scripts/build-linux-angle.py /absolute/task-local/angle-build
The workspace must be empty on first use. Network access downloads pinned tools.
Use --prepared only to package an already built tree from this recipe.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile

root = pathlib.Path.cwd()
work = pathlib.Path(sys.argv[1]).resolve()
lock = json.loads((root / 'build/angle-runtime.json').read_text())
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
assert json.loads((root / 'node_modules/electron/package.json').read_text())['version'] == lock['electronVersion']
for name, digest in lock['electronPatches'].items():
    assert sha(root / 'build/angle-electron-patches' / name) == digest
work.mkdir(parents=True, exist_ok=True)
angle, depot = work / 'angle', work / 'depot_tools'
env = dict(os.environ, DEPOT_TOOLS_UPDATE='0', VPYTHON_BYPASS='manually managed python not supported by chrome operations')

def run(args, cwd=work):
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)

if '--prepared' not in sys.argv:
    assert not angle.exists(), 'Use a new workspace; existing source is never overwritten'
    run(['git', 'clone', 'https://chromium.googlesource.com/chromium/tools/depot_tools.git', depot])
    run(['git', 'checkout', lock['depotToolsRevision']], depot)
    run(['git', 'init', angle])
    run(['git', 'remote', 'add', 'origin', 'https://chromium.googlesource.com/angle/angle.git'], angle)
    run(['git', 'fetch', '--depth=1', 'origin', lock['angleRevision']], angle)
    run(['git', 'checkout', '--detach', 'FETCH_HEAD'], angle)
    for name in lock['electronPatches']:
        run(['git', 'apply', root / 'build/angle-electron-patches' / name], angle)
    run(['git', 'apply', root / 'build/patches/angle-x11-vulkan-visual.patch'], angle)
    custom = {k: False for k in ['checkout_angle_dawn_deps', 'checkout_angle_cl_deps', 'checkout_angle_restricted_traces', 'checkout_android', 'checkout_fuchsia', 'checkout_angle_mesa', 'checkout_angle_partition_alloc']}
    (work / '.gclient').write_text('solutions = ' + repr([{'name': 'angle', 'url': 'https://chromium.googlesource.com/angle/angle.git', 'managed': False, 'custom_vars': custom, 'custom_deps': {}}]) + '\ntarget_os = []\n')
    # Bootstrap depot_tools' own Python, then use it explicitly (host Python may
    # be too new for the pinned Chromium gsutil scripts).
    run([depot / 'ensure_bootstrap'])
    python = depot / '.cipd_bin/3.11/bin/python3'
    env['PATH'] = str(python.parent) + ':' + str(depot) + ':' + env['PATH']
    run([python, depot / 'gclient.py', 'sync', '--no-history', '--nohooks', '--shallow', '--jobs=8'])
    run([python, 'build/linux/sysroot_scripts/install-sysroot.py', '--arch=amd64'], angle)
    (angle / 'out/Javdex').mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / 'build/angle-args.gn', angle / 'out/Javdex/args.gn')
    run(['buildtools/linux64/gn', 'gen', 'out/Javdex'], angle)
    jobs = int(os.environ.get('JAVDEX_ANGLE_JOBS', min(os.cpu_count() or 1, 4)))
    assert 1 <= jobs <= 8, 'ANGLE jobs must be between 1 and 8'
    run(['third_party/ninja/ninja', '-C', 'out/Javdex', '-j' + str(jobs), 'libEGL', 'libGLESv2'], angle)

assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=angle, text=True).strip() == lock['angleRevision']
assert (angle / 'out/Javdex/args.gn').read_bytes() == (root / 'build/angle-args.gn').read_bytes()
run(['git', 'apply', '--reverse', '--check', root / 'build/patches/angle-x11-vulkan-visual.patch'], angle)
destination = root / 'out/linux-angle-runtime'
destination.mkdir(parents=True, exist_ok=True)
pair = destination / 'linux-x64'
assert not pair.exists(), 'Preserve or move the previous runtime before rebuilding'
pair.mkdir()
for name in ['libEGL.so', 'libGLESv2.so']:
    shutil.copy2(angle / 'out/Javdex' / name, pair / name)
    shutil.copy2(angle / 'LICENSE', pair / 'ANGLE-LICENSE.txt')
bundle = destination / ('Javdex-ANGLE-Sources-' + sha(root / 'build/patches/angle-x11-vulkan-visual.patch')[:12] + '.tar.gz')
# Keep the complete source/dependency checkout, excluding VCS metadata, generated
# binaries, downloaded compilers and the Debian sysroot. DEPS pins these tools.
def source_filter(info):
    parts = pathlib.PurePosixPath(info.name).parts
    if any(p in {'.git', 'out', '__pycache__', '.cipd', 'node_modules', 'llvm-build'} or p.endswith(('_sysroot', '-sysroot')) for p in parts):
        return None
    assert not any(c in info.name for c in ('\\', ':', '\x00')) and not info.name.startswith('/') and all(p not in {'.', '..'} for p in parts), 'Unsafe ANGLE source path: ' + repr(info.name)
    if parts[0] == 'angle':
        assert (angle / pathlib.Path(*parts[1:])).resolve().is_relative_to(angle.resolve()), 'ANGLE source link escapes checkout'
    assert info.isfile() or info.isdir(), 'Only regular ANGLE source materials are delivered'
    return info
with tarfile.open(bundle, 'w:gz', compresslevel=3, dereference=True) as archive:
    archive.add(angle, arcname='angle', filter=source_filter)
    for name in ['scripts/build-linux-angle.py', 'build/angle-args.gn', 'build/angle-runtime.json', 'build/angle-electron-patches', 'build/patches/angle-x11-vulkan-visual.patch']:
        archive.add(root / name, arcname='recipe/' + name)
    archive.add(work / '.gclient', arcname='gclient-config')
manifest = dict(schemaVersion=1, electronVersion=lock['electronVersion'], angleRevision=lock['angleRevision'],
    x11RequestedVisual=True, patchSha256=sha(root / 'build/patches/angle-x11-vulkan-visual.patch'),
    argsSha256=sha(root / 'build/angle-args.gn'), provenanceSha256=sha(root / 'build/angle-runtime.json'),
    files={name: sha(pair / name) for name in ['libEGL.so', 'libGLESv2.so']},
    sourceBundle=dict(filename=bundle.name, sha256=sha(bundle), bytes=bundle.stat().st_size))
(pair / 'javdex-angle.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
