"""Open local paths without starting a command interpreter.

Call from a worker thread: path metadata and Windows Shell calls can block.
"""

import os
import platform
import stat
import subprocess
import time
from pathlib import Path


class ForegroundActivationError(RuntimeError):
    """The directory opened, but its Explorer window could not be activated."""


def _activate_explorer_window(hwnd: int) -> bool:
    import win32api
    import win32con
    import win32gui

    if not win32gui.IsWindow(hwnd):
        return False
    win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)

    def activate() -> bool:
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            # Windows may reject this call for a background server process.
            pass
        return win32gui.GetForegroundWindow() == hwnd

    if activate():
        return True

    # Restore the previous Alt-based activation fallback, using native calls.
    # Don't synthesize input while the user is holding a shortcut modifier.
    modifiers = (win32con.VK_MENU, win32con.VK_CONTROL, win32con.VK_SHIFT,
                 win32con.VK_LWIN, win32con.VK_RWIN)
    if any(win32api.GetAsyncKeyState(key) & 0x8000 for key in modifiers):
        return False
    try:
        win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
    finally:
        win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.02)
    return activate()


def _foreground_explorer(directory: Path) -> bool:
    import win32com.client
    import win32con
    import win32gui

    expected_path = os.path.normcase(os.path.normpath(str(directory)))
    shell_app = win32com.client.Dispatch('Shell.Application')
    deadline = time.monotonic() + 2.0
    while True:
        # Reused windows are available immediately; new ones register shortly
        # after the native open call. Only activate the requested directory.
        for window in shell_app.Windows():
            try:
                path = window.Document.Folder.Self.Path
                if os.path.normcase(os.path.normpath(path)) != expected_path:
                    continue
                hwnd = win32gui.GetAncestor(int(window.HWND), win32con.GA_ROOT)
            except Exception:
                # A window can close or navigate while COM is enumerating it.
                continue
            return _activate_explorer_window(hwnd)
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def _open_windows_path(target: Path, is_directory: bool) -> None:
    import pythoncom
    import win32api
    import win32con
    from win32com.shell import shell

    # NiceGUI's worker threads don't initialize COM themselves.
    pythoncom.CoInitialize()
    try:
        if is_directory:
            win32api.ShellExecute(
                0, 'open', str(target), None, None, win32con.SW_SHOWMAXIMIZED,
            )
        else:
            item_id, _ = shell.SHParseDisplayName(str(target), 0)
            # With no child IDs, Shell opens the parent and selects this item.
            shell.SHOpenFolderAndSelectItems(item_id, [], 0)
        directory = target if is_directory else target.parent
        if not _foreground_explorer(directory):
            raise ForegroundActivationError('目录已打开，但未能将资源管理器切到前台，请点击任务栏中的资源管理器。')
    finally:
        pythoncom.CoUninitialize()


def open_in_file_manager(path_value: str) -> str | None:
    target = Path(path_value).expanduser().absolute()
    try:
        is_directory = stat.S_ISDIR(target.stat().st_mode)
        system = platform.system()
        if system == 'Windows':
            _open_windows_path(target, is_directory)
        elif system == 'Darwin':
            subprocess.Popen(['open', str(target)] if is_directory else ['open', '-R', str(target)])
        else:
            subprocess.Popen(['xdg-open', str(target if is_directory else target.parent)])
    except FileNotFoundError:
        return f'路径不存在或文件管理器不可用: {target}'
    except ForegroundActivationError as exc:
        return str(exc)
    except Exception as exc:
        return f'打开文件夹失败: {exc}'
    return None
