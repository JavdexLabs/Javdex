#!/usr/bin/env python3
"""Inspect one packaged libmpv in a fresh process; no device/playback claims."""
import ctypes
import hashlib
import json
import pathlib
import sys

library = pathlib.Path(sys.argv[1]).resolve(strict=True)
# Static libplacebo in this runtime references the C++ ABI dynamically.
ctypes.CDLL('libstdc++.so.6', mode=ctypes.RTLD_GLOBAL)
mpv = ctypes.CDLL(str(library))
mpv.mpv_create.restype = ctypes.c_void_p
mpv.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
mpv.mpv_initialize.argtypes = [ctypes.c_void_p]
mpv.mpv_get_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
mpv.mpv_get_property_string.restype = ctypes.c_void_p
mpv.mpv_free.argtypes = [ctypes.c_void_p]
mpv.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]
handle = mpv.mpv_create()
assert handle, 'mpv_create failed'
try:
    for name, value in [('config', 'no'), ('load-scripts', 'no'), ('vo', 'null'), ('ao', 'null')]:
        assert mpv.mpv_set_option_string(handle, name.encode(), value.encode()) >= 0
    assert mpv.mpv_initialize(handle) >= 0
    def get(name):
        ptr = mpv.mpv_get_property_string(handle, name.encode())
        assert ptr, f'Missing property: {name}'
        try:
            return ctypes.string_at(ptr).decode()
        finally:
            mpv.mpv_free(ptr)
    decoders = json.loads(get('decoder-list'))
    selected = [d for d in decoders if d['codec'] in ['h264', 'hevc', 'av1']]
    assert all(any(d['codec'] == codec for d in selected) for codec in ['h264', 'hevc', 'av1'])
    mpv.avcodec_configuration.restype = ctypes.c_char_p
    mpv.av_hwdevice_iterate_types.argtypes = [ctypes.c_int]
    mpv.av_hwdevice_get_type_name.argtypes = [ctypes.c_int]
    mpv.av_hwdevice_get_type_name.restype = ctypes.c_char_p
    hardware = []
    device = mpv.av_hwdevice_iterate_types(0)
    while device:
        hardware.append(mpv.av_hwdevice_get_type_name(device).decode())
        device = mpv.av_hwdevice_iterate_types(device)
    print(json.dumps({'library': str(library), 'sha256': hashlib.sha256(library.read_bytes()).hexdigest(),
        'compiledHardwareDeviceTypes': hardware, 'ffmpegConfiguration': mpv.avcodec_configuration().decode(), 'mpv': get('mpv-version'), 'ffmpeg': get('ffmpeg-version'), 'selectedDecoders': selected,
        'decoderCount': len(decoders), 'decoders': decoders,
        'scope': 'Compiled decoder inventory only; hardware initialization and visible playback require separate tests.'}, indent=2))
finally:
    mpv.mpv_terminate_destroy(handle)
