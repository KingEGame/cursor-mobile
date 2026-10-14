#!/usr/bin/env python3
"""Raise Cursor IDE windows on X11: unminimize + activate.

Cursor Electron CDP lacks Browser.getWindowForTarget / setWindowBounds, so a
minimized window cannot receive Input.* clicks. This helper talks to the window
manager via EWMH (_NET_WM_STATE / _NET_ACTIVE_WINDOW).

Exit 0 when at least one Cursor window was activated; 1 otherwise.
No third-party deps beyond python-xlib (already on this PC).
"""

from __future__ import annotations

import sys

try:
    from Xlib import X, display
    from Xlib.protocol import event
except ImportError:
    print("raise-cursor-x11: python-xlib missing", file=sys.stderr)
    sys.exit(2)


def _atom(d: display.Display, name: str):
    return d.intern_atom(name)


def _activate(d: display.Display, root, win) -> None:
    net_active = _atom(d, "_NET_ACTIVE_WINDOW")
    msg = event.ClientMessage(
        window=win,
        client_type=net_active,
        data=(32, [2, X.CurrentTime, 0, 0, 0]),
    )
    mask = X.SubstructureRedirectMask | X.SubstructureNotifyMask
    root.send_event(msg, event_mask=mask)


def _unminimize(d: display.Display, root, win) -> None:
    net_state = _atom(d, "_NET_WM_STATE")
    hidden = _atom(d, "_NET_WM_STATE_HIDDEN")
    # action 0 = _NET_WM_STATE_REMOVE
    msg = event.ClientMessage(
        window=win,
        client_type=net_state,
        data=(32, [0, hidden, 0, 1, 0]),
    )
    mask = X.SubstructureRedirectMask | X.SubstructureNotifyMask
    root.send_event(msg, event_mask=mask)
    try:
        win.map()
    except Exception:
        pass


def main() -> int:
    d = display.Display()
    root = d.screen().root
    net_clients = _atom(d, "_NET_CLIENT_LIST")
    wm_class = _atom(d, "WM_CLASS")
    net_state = _atom(d, "_NET_WM_STATE")
    hidden = _atom(d, "_NET_WM_STATE_HIDDEN")

    prop = root.get_full_property(net_clients, X.AnyPropertyType)
    if not prop or not prop.value:
        print("raise-cursor-x11: no client list", file=sys.stderr)
        return 1

    raised = 0
    for wid in prop.value:
        win = d.create_resource_object("window", wid)
        try:
            cls = win.get_full_property(wm_class, X.AnyPropertyType)
        except Exception:
            continue
        if not cls or not cls.value:
            continue
        label = (
            cls.value.decode("utf-8", "replace")
            if isinstance(cls.value, (bytes, bytearray))
            else str(cls.value)
        )
        parts = [p.lower() for p in label.split("\x00") if p]
        # Main IDE: WM_CLASS "cursor", "cursor"
        if "cursor" not in parts:
            continue

        try:
            state = win.get_full_property(net_state, X.AnyPropertyType)
            if state and hidden in (state.value or ()):
                _unminimize(d, root, win)
            _activate(d, root, win)
            raised += 1
        except Exception as err:
            print(f"raise-cursor-x11: skip {wid:#x}: {err}", file=sys.stderr)

    d.flush()
    if raised == 0:
        print("raise-cursor-x11: no Cursor window found", file=sys.stderr)
        return 1
    print(f"raise-cursor-x11: raised {raised}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
