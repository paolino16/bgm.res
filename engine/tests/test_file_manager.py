"""Offline coverage: no real file-manager windows are opened by these tests."""

import asyncio
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

from src.utils import file_manager


class FileManagerTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'win32', 'Windows Shell adapter')
    def test_windows_folder_and_unicode_file_use_native_shell(self):
        import pythoncom
        import win32api
        import win32con
        from win32com.shell import shell

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            video = folder / "剧集 [01] & group's.mkv"
            video.touch()
            with patch.object(pythoncom, 'CoInitialize') as initialize, \
                 patch.object(pythoncom, 'CoUninitialize') as uninitialize, \
                 patch.object(win32api, 'ShellExecute') as execute, \
                 patch.object(shell, 'SHParseDisplayName', return_value=(['item-id'], 0)) as parse, \
                 patch.object(shell, 'SHOpenFolderAndSelectItems') as select, \
                 patch.object(file_manager, '_foreground_explorer', return_value=True) as foreground, \
                 patch.object(file_manager.subprocess, 'Popen') as spawn:
                self.assertIsNone(file_manager.open_in_file_manager(str(folder)))
                execute.assert_called_once_with(0, 'open', str(folder), None, None, win32con.SW_SHOWMAXIMIZED)
                self.assertIsNone(file_manager.open_in_file_manager(str(video)))
                parse.assert_called_once_with(str(video), 0)
                select.assert_called_once_with(['item-id'], [], 0)
                spawn.assert_not_called()
                self.assertEqual(initialize.call_count, 2)
                self.assertEqual(uninitialize.call_count, 2)
                self.assertEqual(foreground.call_count, 2)
                foreground.assert_called_with(folder)

    @unittest.skipUnless(sys.platform == 'win32', 'Windows Shell adapter')
    def test_shell_failure_cleans_up_com_and_reports_error(self):
        import pythoncom
        import win32api

        with tempfile.TemporaryDirectory() as directory, \
             patch.object(pythoncom, 'CoInitialize'), \
             patch.object(pythoncom, 'CoUninitialize') as cleanup, \
             patch.object(win32api, 'ShellExecute', side_effect=RuntimeError('shell unavailable')):
            error = file_manager.open_in_file_manager(directory)
            self.assertIn('shell unavailable', error)
            cleanup.assert_called_once()

    def test_missing_path_never_launches_shell(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(file_manager, '_open_windows_path') as launch:
            error = file_manager.open_in_file_manager(str(Path(directory) / 'missing'))
            self.assertIn('路径不存在', error)
            launch.assert_not_called()

    def test_non_windows_file_reveal(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / 'episode.mkv'
            video.touch()
            with patch.object(file_manager.platform, 'system', return_value='Darwin'), \
                 patch.object(file_manager.subprocess, 'Popen') as launch:
                self.assertIsNone(file_manager.open_in_file_manager(str(video)))
                launch.assert_called_once_with(['open', '-R', str(video)])
            with patch.object(file_manager.platform, 'system', return_value='Linux'), \
                 patch.object(file_manager.subprocess, 'Popen') as launch:
                self.assertIsNone(file_manager.open_in_file_manager(str(video)))
                launch.assert_called_once_with(['xdg-open', str(video.parent)])


@unittest.skipUnless(sys.platform == 'win32', 'Windows foreground activation')
class ForegroundTests(unittest.TestCase):
    def test_direct_activation_does_not_send_keyboard_input(self):
        import win32api
        import win32con
        import win32gui

        with patch.object(win32gui, 'IsWindow', return_value=True), \
             patch.object(win32gui, 'ShowWindow') as show, \
             patch.object(win32gui, 'SetForegroundWindow') as activate, \
             patch.object(win32gui, 'GetForegroundWindow', return_value=42), \
             patch.object(win32api, 'keybd_event') as keyboard:
            self.assertTrue(file_manager._activate_explorer_window(42))
            show.assert_called_once_with(42, win32con.SW_MAXIMIZE)
            activate.assert_called_once_with(42)
            keyboard.assert_not_called()

    def test_foreground_lock_uses_one_paired_alt_fallback(self):
        import win32api
        import win32con
        import win32gui

        with patch.object(win32gui, 'IsWindow', return_value=True), \
             patch.object(win32gui, 'ShowWindow'), \
             patch.object(win32gui, 'SetForegroundWindow', side_effect=[RuntimeError('locked'), None]), \
             patch.object(win32gui, 'GetForegroundWindow', side_effect=[99, 42]), \
             patch.object(win32api, 'GetAsyncKeyState', return_value=0), \
             patch.object(win32api, 'keybd_event') as keyboard, \
             patch.object(file_manager.time, 'sleep'):
            self.assertTrue(file_manager._activate_explorer_window(42))
            self.assertEqual(keyboard.call_args_list, [
                call(win32con.VK_MENU, 0, 0, 0),
                call(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0),
            ])

    def test_held_modifier_prevents_synthetic_shortcuts(self):
        import win32api
        import win32gui

        with patch.object(win32gui, 'IsWindow', return_value=True), \
             patch.object(win32gui, 'ShowWindow'), \
             patch.object(win32gui, 'SetForegroundWindow'), \
             patch.object(win32gui, 'GetForegroundWindow', return_value=99), \
             patch.object(win32api, 'GetAsyncKeyState', return_value=0x8000), \
             patch.object(win32api, 'keybd_event') as keyboard:
            self.assertFalse(file_manager._activate_explorer_window(42))
            keyboard.assert_not_called()

    def test_new_window_is_waited_for_and_only_matching_path_is_activated(self):
        import win32com.client
        import win32gui

        directory = Path('C:/media/show')

        def window(path, hwnd):
            return SimpleNamespace(HWND=hwnd, Document=SimpleNamespace(
                Folder=SimpleNamespace(Self=SimpleNamespace(Path=path))))

        shell_app = MagicMock()
        shell_app.Windows.side_effect = [[], [window('C:/unrelated', 99), window('c:/MEDIA/show', 42)]]
        with patch.object(win32com.client, 'Dispatch', return_value=shell_app), \
             patch.object(win32gui, 'GetAncestor', return_value=42), \
             patch.object(file_manager, '_activate_explorer_window', return_value=True) as activate, \
             patch.object(file_manager.time, 'sleep') as sleep:
            self.assertTrue(file_manager._foreground_explorer(directory))
            activate.assert_called_once_with(42)
            sleep.assert_called_once_with(.05)

    def test_activation_failure_is_reported_without_repeated_key_events(self):
        import win32com.client
        import win32gui

        directory = Path('C:/media/show')
        shell_app = MagicMock()
        shell_app.Windows.return_value = [SimpleNamespace(HWND=42, Document=SimpleNamespace(
            Folder=SimpleNamespace(Self=SimpleNamespace(Path=str(directory)))))]
        with patch.object(win32com.client, 'Dispatch', return_value=shell_app), \
             patch.object(win32gui, 'GetAncestor', return_value=42), \
             patch.object(file_manager, '_activate_explorer_window', return_value=False) as activate, \
             patch.object(file_manager.time, 'sleep') as sleep:
            self.assertFalse(file_manager._foreground_explorer(directory))
            activate.assert_called_once()
            sleep.assert_not_called()




if __name__ == '__main__':
    unittest.main()
