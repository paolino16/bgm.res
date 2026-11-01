param(
    [string]$RuntimeSource = "$env:LOCALAPPDATA\Programs\bgm.res-trial\app\win-unpacked",
    [string]$NodeBinary = (Get-Command node.exe -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $repo '.desktop'
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeSource 'bgm.res.exe'))) { throw '请指定已解压的官方 bgm.res Windows 便携版目录。' }
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Get-ChildItem -LiteralPath $RuntimeSource | Where-Object Name -ne 'resources' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $runtime -Recurse -Force
}
$appDir = Join-Path $runtime 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
@{name='bgm-res-manager'; version='0.1.0'; main='index.cjs'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appDir 'package.json') -Encoding utf8
$entry = Join-Path $repo 'manager\electron.cjs'
$entryJSON = ConvertTo-Json -InputObject $entry -Compress
[IO.File]::WriteAllText((Join-Path $appDir 'index.cjs'), "require($entryJSON);", [Text.UTF8Encoding]::new($false))
$launcher = "@echo off`r`nset `"BGM_MANAGER_NODE=$NodeBinary`"`r`nstart `"bgm.res manager`" `"%~dp0.desktop\bgm.res.exe`"`r`n"
[IO.File]::WriteAllText((Join-Path $repo '启动收藏管理.cmd'), $launcher, [Text.Encoding]::Default)
Write-Output (Join-Path $repo '启动收藏管理.cmd')
