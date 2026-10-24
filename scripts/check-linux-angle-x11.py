#!/usr/bin/env python3
"""Live X11 ANGLE regression: requested ARGB visuals, no video or user data."""
import ctypes as C
import json
import pathlib
import sys

P, I, U = C.c_void_p, C.c_int, C.c_uint

def bind(lib, name, result, args):
    f = getattr(lib, name)
    f.restype, f.argtypes = result, args
    return f

class Visual(C.Structure):
    _fields_ = [('visual', P), ('id', C.c_ulong), ('screen', I), ('depth', I),
                ('kind', I), ('red', C.c_ulong), ('green', C.c_ulong),
                ('blue', C.c_ulong), ('colormap', I), ('bits', I)]

x = C.CDLL('libX11.so.6')
xdisplay = bind(x, 'XOpenDisplay', P, [C.c_char_p])(None)
assert xdisplay, 'This test requires a live X11/XWayland display'
count = I()
visuals = bind(x, 'XGetVisualInfo', C.POINTER(Visual), [P, C.c_long, C.POINTER(Visual), C.POINTER(I)])(xdisplay, 0, C.byref(Visual()), C.byref(count))
choices = [visuals[i].id for i in range(count.value) if visuals[i].depth == 32 and visuals[i].kind == 4]
bind(x, 'XFree', I, [P])(visuals)
assert choices, 'No ARGB TrueColor visual available'
e = C.CDLL(str(pathlib.Path(sys.argv[1]).resolve() / 'libEGL.so'))
platform = bind(e, 'eglGetPlatformDisplay', P, [U, P, C.POINTER(C.c_ssize_t)])
initialize = bind(e, 'eglInitialize', U, [P, C.POINTER(I), C.POINTER(I)])
configs = bind(e, 'eglGetConfigs', U, [P, C.POINTER(P), I, C.POINTER(I)])
attribute = bind(e, 'eglGetConfigAttrib', U, [P, P, I, C.POINTER(I)])
terminate = bind(e, 'eglTerminate', U, [P])
results = []
for visual in choices[:2]:
    attrs = [0x3203, 0x3450, 0x348f, 0x31d5, 0x33a3, visual, 0x3038]
    display = platform(0x3202, xdisplay, (C.c_ssize_t * len(attrs))(*attrs))
    major, minor = I(), I()
    assert display and initialize(display, C.byref(major), C.byref(minor)), 'ANGLE Vulkan initialization failed'
    n = I()
    assert configs(display, None, 0, C.byref(n)) and 0 < n.value < 1024
    values = (P * n.value)()
    assert configs(display, values, n.value, C.byref(n))
    for config in values:
        actual = I()
        assert attribute(display, config, 0x302e, C.byref(actual))
        assert actual.value == visual, f'ANGLE returned root visual {actual.value:#x} instead of requested {visual:#x}'
    results.append({'requestedVisual': hex(visual), 'matchingConfigs': n.value})
    assert terminate(display)
attrs = [0x3203, 0x3450, 0x348f, 0x31d5, 0x33a3, 0x7fffffff, 0x3038]
display = platform(0x3202, xdisplay, (C.c_ssize_t * len(attrs))(*attrs))
assert not display or not initialize(display, None, None), 'Invalid visual was accepted'
bind(x, 'XCloseDisplay', I, [P])(xdisplay)
print(json.dumps({'pass': True, 'visuals': results, 'invalidVisualRejected': True}))
