$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ExplorerForeground {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
}
"@
$folders = @($env:BGM_EXPLORER_FOLDERS | ConvertFrom-Json)
$shell = New-Object -ComObject Shell.Application
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  foreach ($window in @($shell.Windows())) {
    try {
      if ([IO.Path]::GetFileName($window.FullName) -ine 'explorer.exe') { continue }
      # Shell URLs may contain legacy escapes (e.g. ½ becomes %BD).
      # Read the filesystem path directly instead of decoding LocationURL.
      $location = ([string]$window.Document.Folder.Self.Path).TrimEnd('\')
      if (-not ($folders | Where-Object { $_.TrimEnd('\') -ieq $location })) { continue }
      $handle = [IntPtr]([long]$window.HWND)
      if ([ExplorerForeground]::GetForegroundWindow() -eq $handle) { exit 0 }
      if ([ExplorerForeground]::IsIconic($handle)) { [void][ExplorerForeground]::ShowWindowAsync($handle, 9) }
      if ([ExplorerForeground]::SetForegroundWindow($handle)) { exit 0 }
      if ([ExplorerForeground]::GetForegroundWindow() -eq $handle) { exit 0 }
      $foregroundThread = [ExplorerForeground]::GetWindowThreadProcessId([ExplorerForeground]::GetForegroundWindow(), [IntPtr]::Zero)
      $currentThread = [ExplorerForeground]::GetCurrentThreadId()
      $attached = $false
      try {
        if ($foregroundThread -ne $currentThread) { $attached = [ExplorerForeground]::AttachThreadInput($currentThread, $foregroundThread, $true) }
        if ([ExplorerForeground]::SetForegroundWindow($handle)) { exit 0 }
        if ([ExplorerForeground]::GetForegroundWindow() -eq $handle) { exit 0 }
      } finally {
        if ($attached) { [void][ExplorerForeground]::AttachThreadInput($currentThread, $foregroundThread, $false) }
      }
    } catch { }
  }
  Start-Sleep -Milliseconds 100
}
throw 'Could not bring the Explorer folder to the foreground'
