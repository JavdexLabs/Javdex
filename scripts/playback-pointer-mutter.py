"""Ephemeral GNOME native pointer input for the owned Electron test window."""
import dbus
import sys
import time

bus = dbus.SessionBus()
root = bus.get_object('org.gnome.Mutter.RemoteDesktop', '/org/gnome/Mutter/RemoteDesktop')
session_path = dbus.Interface(root, 'org.gnome.Mutter.RemoteDesktop').CreateSession()
session = dbus.Interface(bus.get_object('org.gnome.Mutter.RemoteDesktop', session_path), 'org.gnome.Mutter.RemoteDesktop.Session')
started = False
pressed = False
try:
    session.Start()
    started = True
    if sys.argv[1] == 'move':
        session.NotifyPointerMotionRelative(float(sys.argv[2]), float(sys.argv[3]))
        time.sleep(.15)
    else:
        gap, hold = float(sys.argv[2]) / 1000, float(sys.argv[3]) / 1000
        for index in range(2):
            session.NotifyPointerButton(272, True)
            pressed = True
            time.sleep(.015 + (hold if index else 0))
            session.NotifyPointerButton(272, False)
            pressed = False
            if not index:
                time.sleep(gap)
        time.sleep(.1)
finally:
    if started:
        if pressed:
            session.NotifyPointerButton(272, False)
        session.Stop()
