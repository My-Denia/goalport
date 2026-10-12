"""Minimal X11 bounds control for exactly one verified owned Electron window.

No title-only selection, no installs, no environment/system changes. Other
windows' names/classes are never read. Pure policy helpers are importable
without opening a display or loading Xlib.
"""
import argparse
import ctypes as c
import json
from pathlib import Path


def validate_request(pid, width, height):
    if type(pid) is not int or pid <= 1:
        raise ValueError('positive owned Electron PID required')
    if type(width) is not int or width not in (860, 1020, 1440):
        raise ValueError('unsupported acceptance width')
    if type(height) is not int or height != 900:
        raise ValueError('acceptance height must be 900')


def is_descendant(pid, owner, parent_of):
    visited = set()
    while pid > 1 and pid not in visited:
        if pid == owner:
            return True
        visited.add(pid)
        pid = parent_of(pid)
    return False


def select_owned_window(candidates, owner, parent_of):
    owned = [item for item in candidates
             if is_descendant(item['pid'], owner, parent_of)
             and (item['title'] == 'GoalPort' or item['title'].startswith('GoalPort '))
             and any(term in item['class'].lower() for term in ('electron', 'goalport'))]
    if len(owned) != 1:
        raise ValueError('owned GoalPort window absent or ambiguous; verified-PID candidates: ' + json.dumps([item for item in candidates if is_descendant(item['pid'], owner, parent_of)]))
    return owned[0]


def parent_of(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        return int(stat[stat.rfind(')') + 2:].split()[1])
    except (OSError, ValueError, IndexError):
        return 0


def resize(pid, width, height, inset_width=0, inset_height=0):
    validate_request(pid, width, height)
    if any(type(value) is not int or not 0 <= value <= 32 for value in (inset_width, inset_height)):
        raise ValueError('invalid native frame insets')
    x = c.CDLL('libX11.so.6')
    Display = c.c_void_p
    Window = c.c_ulong
    Atom = c.c_ulong
    x.XOpenDisplay.argtypes = [c.c_char_p]
    x.XOpenDisplay.restype = Display
    x.XDefaultRootWindow.argtypes = [Display]
    x.XDefaultRootWindow.restype = Window
    x.XInternAtom.argtypes = [Display, c.c_char_p, c.c_int]
    x.XInternAtom.restype = Atom
    x.XGetWindowProperty.argtypes = [Display, Window, Atom, c.c_long, c.c_long, c.c_int, Atom, c.POINTER(Atom), c.POINTER(c.c_int), c.POINTER(c.c_ulong), c.POINTER(c.c_ulong), c.POINTER(c.c_void_p)]
    x.XQueryTree.argtypes = [Display, Window, c.POINTER(Window), c.POINTER(Window), c.POINTER(c.POINTER(Window)), c.POINTER(c.c_uint)]
    x.XFetchName.argtypes = [Display, Window, c.POINTER(c.c_void_p)]
    class ClassHint(c.Structure):
        _fields_ = [('name', c.c_void_p), ('class_name', c.c_void_p)]
    x.XGetClassHint.argtypes = [Display, Window, c.POINTER(ClassHint)]
    x.XGetGeometry.argtypes = [Display, Window, c.POINTER(Window), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint)]
    x.XResizeWindow.argtypes = [Display, Window, c.c_uint, c.c_uint]
    x.XSync.argtypes = [Display, c.c_int]
    x.XFree.argtypes = [c.c_void_p]
    x.XCloseDisplay.argtypes = [Display]
    # Disappearing unrelated windows are ignored rather than triggering Xlib's
    # default process-exit handler during the read-only ownership enumeration.
    handler_type = c.CFUNCTYPE(c.c_int, Display, c.c_void_p)
    handler = handler_type(lambda *_: 0)
    x.XSetErrorHandler.argtypes = [handler_type]
    x.XSetErrorHandler(handler)
    display = x.XOpenDisplay(None)
    if not display:
        raise ValueError('X11 display unavailable')
    try:
        pid_atom = x.XInternAtom(display, b'_NET_WM_PID', 1)
        if not pid_atom:
            raise ValueError('X11 PID ownership property unavailable')
        def window_pid(window):
            kind, fmt, count, after, data = Atom(), c.c_int(), c.c_ulong(), c.c_ulong(), c.c_void_p()
            status = x.XGetWindowProperty(display, window, pid_atom, 0, 1, 0, 0, c.byref(kind), c.byref(fmt), c.byref(count), c.byref(after), c.byref(data))
            try:
                if status == 0 and fmt.value == 32 and count.value == 1 and data.value:
                    return c.cast(data, c.POINTER(c.c_ulong))[0]
                return 0
            finally:
                if data.value:
                    x.XFree(data)
        name_atom = x.XInternAtom(display, b'_NET_WM_NAME', 1)
        def modern_title(window):
            if not name_atom:
                return ''
            kind, fmt, count, after, data = Atom(), c.c_int(), c.c_ulong(), c.c_ulong(), c.c_void_p()
            status = x.XGetWindowProperty(display, window, name_atom, 0, 256, 0, 0, c.byref(kind), c.byref(fmt), c.byref(count), c.byref(after), c.byref(data))
            try:
                return c.string_at(data, count.value).decode('utf8', 'replace') if status == 0 and fmt.value == 8 and data.value else ''
            finally:
                if data.value:
                    x.XFree(data)
        def children(window):
            root, parent, values, count = Window(), Window(), c.POINTER(Window)(), c.c_uint()
            if not x.XQueryTree(display, window, c.byref(root), c.byref(parent), c.byref(values), c.byref(count)):
                return []
            try:
                return [values[i] for i in range(count.value)]
            finally:
                if values:
                    x.XFree(values)
        candidates, queue, visited = [], [x.XDefaultRootWindow(display)], set()
        while queue:
            window = queue.pop()
            if window in visited:
                continue
            visited.add(window)
            if len(visited) > 10000:
                raise ValueError('X11 enumeration bound exceeded')
            queue.extend(children(window))
            wp = window_pid(window)
            if not wp or not is_descendant(wp, pid, parent_of):
                continue
            title = c.c_void_p()
            hint = ClassHint()
            try:
                x.XFetchName(display, window, c.byref(title))
                x.XGetClassHint(display, window, c.byref(hint))
                candidates.append({'id': window, 'pid': wp,
                                   'title': modern_title(window) or (c.string_at(title).decode('utf8', 'replace') if title.value else ''),
                                   'class': ' '.join(c.string_at(v).decode('utf8', 'replace') for v in [hint.name, hint.class_name] if v)})
            finally:
                for value in [title.value, hint.name, hint.class_name]:
                    if value:
                        x.XFree(c.c_void_p(value))
        owned = select_owned_window(candidates, pid, parent_of)
        # Recheck identity immediately before mutation; no title-only fallback.
        if window_pid(owned['id']) != owned['pid'] or not is_descendant(owned['pid'], pid, parent_of):
            raise ValueError('owned window identity changed before resize')
        x.XResizeWindow(display, owned['id'], width + inset_width, height + inset_height)
        x.XSync(display, 0)
        root, gx, gy = Window(), c.c_int(), c.c_int()
        gw, gh, border, depth = c.c_uint(), c.c_uint(), c.c_uint(), c.c_uint()
        if not x.XGetGeometry(display, owned['id'], c.byref(root), c.byref(gx), c.byref(gy), c.byref(gw), c.byref(gh), c.byref(border), c.byref(depth)):
            raise ValueError('owned window geometry unavailable')
        return {'windowId': hex(owned['id']), 'windowPid': owned['pid'], 'electronPid': pid,
                'identity': {'title': owned['title'], 'class': owned['class']},
                'requestedViewport': {'width': width, 'height': height},
                'requestedClientBounds': {'width': width + inset_width, 'height': height + inset_height},
                'observedFrameInsets': {'width': inset_width, 'height': inset_height},
                'observedClientBounds': {'width': gw.value, 'height': gh.value}, 'method': 'X11 XResizeWindow (PID + class/title verified)'}
    finally:
        x.XCloseDisplay(display)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--width', type=int, required=True)
    parser.add_argument('--height', type=int, required=True)
    parser.add_argument('--inset-width', type=int, default=0)
    parser.add_argument('--inset-height', type=int, default=0)
    args = parser.parse_args()
    try:
        print(json.dumps(resize(args.pid, args.width, args.height, args.inset_width, args.inset_height)))
    except (ValueError, OSError) as error:
        parser.exit(2, f'Native resize refused: {error}\n')
