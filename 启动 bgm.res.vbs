Option Explicit
Dim shell, fso, root, exe, env
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(root, ".linked-desktop\bgm.res.exe")
If Not fso.FileExists(exe) Then
  MsgBox "bgm.res executable was not found: " & exe, 16, "bgm.res"
  WScript.Quit 1
End If
Set env = shell.Environment("Process")
env("BGM_RES_DATA_DIR") = shell.ExpandEnvironmentStrings("%APPDATA%") & "\bgm.res-linked"
env("BGM_RENAME_DATA") = env("BGM_RES_DATA_DIR") & "\rename"
env("BGM_RENAME_PROJECT") = fso.BuildPath(root, "engine")
shell.CurrentDirectory = root
If WScript.Arguments.Named.Exists("check") Then
  WScript.Echo "bgm.res launcher OK"
  WScript.Quit 0
End If
shell.Run Chr(34) & exe & Chr(34), 1, False
