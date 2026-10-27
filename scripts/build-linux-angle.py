#!/usr/bin/env python3
"""Build the Electron-matched ANGLE pair without modifying host packages.

Usage: python3 scripts/build-linux-angle.py /absolute/task-local/angle-build
The workspace must be empty on first use. Network access downloads pinned tools.
Use --prepared only to package an already built tree from this recipe.
"""
import hashlib
import io
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
bundle = destination / ('Javdex-ANGLE-Rebuild-' + sha(root / 'build/patches/angle-x11-vulkan-visual.patch')[:12] + '.tar.gz')
# ANGLE is BSD-licensed. Deliver pinned reconstruction inputs and all checked-out
# license/notice texts, rather than copying its full dependency source tree.
def source_filter(info, source_root=None):
    parts = pathlib.PurePosixPath(info.name).parts
    assert not any(c in info.name for c in ('\\', ':', '\x00')) and not info.name.startswith('/') and all(p not in {'.', '..'} for p in parts), 'Unsafe ANGLE source path: ' + repr(info.name)
    if any(p in {'.git', 'out', '__pycache__', '.cipd', 'node_modules', 'llvm-build'} or p.endswith(('_sysroot', '-sysroot')) for p in parts):
        return None
    source_root = source_root or angle
    if parts[0] == 'angle':
        assert (source_root / pathlib.Path(*parts[1:])).resolve().is_relative_to(source_root.resolve()), 'ANGLE source link escapes checkout'
    assert info.isfile() or info.isdir(), 'Only regular ANGLE source materials are delivered'
    preferred = {'include/EGL/egl.h', 'src/libANGLE/renderer/vulkan/linux/xcb/DisplayVkXcb.cpp',
                 'src/libANGLE/renderer/vulkan/linux/xcb/DisplayVkXcb.h', 'build/linux/sysroot_scripts/install-sysroot.py'}
    name = parts[-1].lower()
    notice = name.startswith(('license', 'licence', 'copying', 'copyright', 'notice', 'patents', 'authors')) or any(p.lower() in {'licenses', 'licences'} for p in parts[:-1])
    return info if info.isdir() or notice or name == 'deps' or '/'.join(parts[1:]) in preferred else None

def create_source_bundle(bundle, angle, root, work, lock):
    files = {}
    with tarfile.open(bundle, 'w:gz', compresslevel=9, dereference=True) as archive:
        def add(name, content):
            entry = tarfile.TarInfo(name); entry.size = len(content); entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(content))
            files[name] = hashlib.sha256(content).hexdigest()
        for directory, subdirs, names in os.walk(angle, followlinks=False):
            parent = pathlib.Path(directory)
            kept = []
            for name in sorted(subdirs):
                info = archive.gettarinfo(parent / name, arcname='angle/' + (parent / name).relative_to(angle).as_posix())
                if source_filter(info, angle) is not None:
                    kept.append(name)
            subdirs[:] = kept
            for name in sorted(names):
                file = parent / name
                relative = 'angle/' + file.relative_to(angle).as_posix()
                if source_filter(archive.gettarinfo(file, arcname=relative), angle) is not None:
                    add(relative, file.read_bytes())
        for name in ['scripts/build-linux-angle.py', 'build/angle-args.gn', 'build/angle-runtime.json',
                     'build/patches/angle-x11-vulkan-visual.patch',
                     *['build/angle-electron-patches/' + name for name in lock['electronPatches']]]:
            add('recipe/' + name, (root / name).read_bytes())
        add('gclient-config', (work / '.gclient').read_bytes())
        add('README.txt', b'ANGLE reconstruction materials\n\nThis archive does not contain the full ANGLE source tree. It retains fixed upstream revisions, DEPS, licenses, Electron patches and the Javdex X11 patch. Extract sources/gpu.tar.gz or sources/cpu.tar.gz from the restored Linux delivery and use its recipe/ project as the working directory; this archive only carries the ANGLE-specific recipe subset. Install the matching Electron package and the documented build prerequisites, then run python3 scripts/build-linux-angle.py /absolute/new-workspace. The recipe fetches the pinned ANGLE and depot_tools commits and resolves their pinned dependencies. A network connection is required; this is not an offline source checkout. No reconstruction command runs when restoring this archive.\n')
        reference = dict(schemaVersion=1, kind='angle-rebuild', electronVersion=lock['electronVersion'],
                         angle=dict(url='https://chromium.googlesource.com/angle/angle.git', revision=lock['angleRevision']),
                         depotTools=dict(url='https://chromium.googlesource.com/chromium/tools/depot_tools.git', revision=lock['depotToolsRevision']),
                         files=files.copy())
        add('rebuild.json', (json.dumps(reference, indent=2) + '\n').encode())

create_source_bundle(bundle, angle, root, work, lock)
manifest = dict(schemaVersion=1, electronVersion=lock['electronVersion'], angleRevision=lock['angleRevision'],
    x11RequestedVisual=True, patchSha256=sha(root / 'build/patches/angle-x11-vulkan-visual.patch'),
    argsSha256=sha(root / 'build/angle-args.gn'), provenanceSha256=sha(root / 'build/angle-runtime.json'),
    files={name: sha(pair / name) for name in ['libEGL.so', 'libGLESv2.so']},
    sourceBundle=dict(format='angle-rebuild-v1', filename=bundle.name, sha256=sha(bundle), bytes=bundle.stat().st_size))
(pair / 'javdex-angle.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
