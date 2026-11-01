"""Prepare the original bgm.res UI with source-level binding changes, offline.

Uses the already downloaded official portable package's runtime and dependencies.
Never modifies the official installation or user's media.
"""
import json, os, pathlib, shutil, struct

repo = pathlib.Path(__file__).resolve().parent.parent
source = pathlib.Path(os.environ.get('BGM_RUNTIME_SOURCE') or pathlib.Path(os.environ['LOCALAPPDATA']) / 'Programs/bgm.res-trial/app/win-unpacked')
runtime = repo / '.linked-desktop'
runtime.mkdir(exist_ok=True)
for entry in source.iterdir():
    if entry.name == 'resources':
        continue
    dest = runtime / entry.name
    if entry.is_dir():
        shutil.copytree(entry, dest, dirs_exist_ok=True)
    else:
        shutil.copy2(entry, dest)
archive = source / 'resources/app.asar'
with archive.open('rb') as stream:
    _, header_size, _, json_size = struct.unpack('<4I', stream.read(16))
    header = json.loads(stream.read(json_size))
    base = 8 + header_size
    def extract(entries, relative):
        for name, item in entries.items():
            target = relative / name
            if 'files' in item:
                target.mkdir(parents=True, exist_ok=True)
                extract(item['files'], target)
            elif 'offset' in item:
                stream.seek(base + int(item['offset']))
                target.write_bytes(stream.read(item['size']))
            elif item.get('unpacked'):
                shutil.copy2(pathlib.Path(str(archive)+'.unpacked') / target.relative_to(repo), target)
    extract(header['files']['node_modules']['files'], repo / 'node_modules')
mpv = source / 'resources/app.asar.unpacked/mpv'
if mpv.exists():
    shutil.copytree(mpv, repo / 'mpv', dirs_exist_ok=True)
app_dir = runtime / 'resources/app'
app_dir.mkdir(parents=True, exist_ok=True)
(app_dir / 'package.json').write_text(json.dumps({'name':'bgm-res-linked','version':'0.19.0','main':'index.cjs'}), encoding='utf-8')
(app_dir / 'index.cjs').write_text(
    "const {app}=require('electron'); const path=require('path'); "
    "app.setPath('userData',process.env.BGM_RES_DATA_DIR); "
    "process.chdir("+json.dumps(str(repo))+"); require("+json.dumps(str(repo/'index.js'))+");", encoding='utf-8')
launcher = '@echo off\r\nset "BGM_RES_DATA_DIR=%APPDATA%\\bgm.res-linked"\r\nset "BGM_RENAME_PROJECT=%~dp0..\\Bangumi_Auto_Rename"\r\nset "BGM_RENAME_DATA=%BGM_RENAME_PROJECT%\\data"\r\nstart "bgm.res linked" /D "%~dp0" "%~dp0.linked-desktop\\bgm.res.exe"\r\n'
(repo/'启动原版绑定.cmd').write_text(launcher, encoding='utf-8')
print(repo/'启动原版绑定.cmd')
