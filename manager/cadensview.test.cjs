const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {CadensView,newer,releaseInfo,extract,register,prepareLaunchExecutable,launch,VERSIONS_ROOT,applyAnalysisDefaults}=require('../js/cadensview-main.cjs');
const run=promisify(execFile);
const release={tag_name:'v0.3.0',body:'新版说明',assets:[{name:'CadensView-0.3.0-win-x64.zip',browser_download_url:'https://github.com/dddkkw/CadensView/releases/download/v0.3.0/CadensView-0.3.0-win-x64.zip'}]};
async function program(root,v){const folder=path.join(root,'CadensView-'+v+'-win-x64');await fs.mkdir(path.join(folder,'_internal','shotlab'),{recursive:true});await fs.writeFile(path.join(folder,'_internal','shotlab','Main.qml'),'ApplicationWindow {\n    id: window\n    Connections {\n        function onProjectChanging() {\n        }\n    }\n}\n');await fs.writeFile(path.join(folder,'CadensView.exe'),'fixture');await fs.writeFile(path.join(folder,'BUILD-MANIFEST.json'),JSON.stringify({version:v}));return path.join(folder,'CadensView.exe');}
async function fixture(t,extra={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-cadens-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const exe=await program(directory,'0.1.0'),video=path.join(directory,'中文 视频 [Group].mkv');await fs.writeFile(video,'video');
 let data={path:exe,automatic:true};const events=[],launched=[];
 const manager=new CadensView({directory,store:{get:()=>data,set:(_k,v)=>{data=v;}},notify:e=>events.push(e),latest:async()=>releaseInfo(release),isRunning:async()=>false,
  launchFile:async(exe,file,onExit)=>{launched.push({exe,file,onExit});},downloadFile:async(_asset,zip)=>fs.writeFile(zip,'zip'),extractFile:async(_zip,folder)=>{await program(folder,'0.3.0');},...extra});
 return {manager,video,exe,events,launched,data:()=>data,directory};
}
test('numeric stable versions and official Windows portable asset only',()=>{
 assert.equal(newer('0.10.0','0.3.0'),true);assert.equal(newer('0.3.0','0.3.0'),false);assert.equal(newer('0.3.0-beta','0.1.0'),false);
 assert.equal(releaseInfo(release).version,'0.3.0');assert.throws(()=>releaseInfo({...release,prerelease:true}));
 assert.throws(()=>releaseInfo({...release,assets:[{...release.assets[0],browser_download_url:'https://example.com/app.zip'}]}),/地址/);
});
test('launches the exact Unicode video; duplicate opens do not create another process',async t=>{
 const f=await fixture(t);await Promise.all([f.manager.open(f.video),f.manager.open(f.video)]);assert.equal(f.launched.length,1);assert.equal(f.launched[0].file,f.video);
 assert.equal((await f.manager.open(f.video)).alreadyOpen,true);f.launched[0].onExit();await f.manager.open(f.video);assert.equal(f.launched.length,2);
});
test('offline check never blocks launch and attempts are cached for a day',async t=>{
 let calls=0;const f=await fixture(t,{latest:async()=>{calls++;throw Error('offline');}});
 await f.manager.open(f.video);await f.manager.check();assert.equal(f.launched.length,1);assert.equal(calls,1);assert.match(f.data().checkError,/offline/);
 await f.manager.check();assert.equal(calls,1);await assert.rejects(f.manager.check(true),/offline/);assert.equal(calls,2);
});
test('slow network does not delay opening and automatic check can be disabled',async t=>{
 let finish,calls=0;const f=await fixture(t,{latest:()=>{calls++;return new Promise(r=>finish=r);}});
 await f.manager.open(f.video);assert.equal(calls,1);finish(releaseInfo(release));await f.manager.check();
 await f.manager.configure({automatic:false});f.manager.save({checkedAt:0});await f.manager.check();assert.equal(calls,1);
});
test('missing or empty videos and missing executables never launch',async t=>{
 const f=await fixture(t);await fs.writeFile(f.video,'');await assert.rejects(f.manager.open(f.video),/空文件/);assert.equal(f.launched.length,0);
 await fs.writeFile(f.video,'video');await fs.unlink(f.exe);await assert.rejects(f.manager.open(f.video),/不存在/);assert.equal(f.launched.length,0);
});
test('successful update switches path, preserves original and supports rollback',async t=>{
 const f=await fixture(t);const result=await f.manager.install();assert.equal(result.version,'0.3.0');assert.equal(result.previous.path,f.exe);await fs.access(f.exe);
 await f.manager.open(f.video);assert.equal(f.launched[0].exe,result.path);f.launched[0].onExit();
 assert.equal((await f.manager.rollback()).path,f.exe);
});
test('running program delays switch; pending update survives a new manager',async t=>{
 let busy=true;const f=await fixture(t,{isRunning:async()=>busy});const result=await f.manager.install();assert.equal(result.path,f.exe);assert.equal(result.pending.version,'0.3.0');
 await assert.rejects(f.manager.rollback(),/关闭/);assert.equal(await f.manager.applyPending(),false);
 const restarted=new CadensView({directory:f.directory,store:f.manager.store,isRunning:async()=>busy});busy=false;await restarted.applyPending();assert.equal((await restarted.status()).version,'0.3.0');
});
test('failed download or invalid package leaves current path and cleans staging files',async t=>{
 for(const failure of ['download','version']){
  const f=await fixture(t,failure==='download'?{downloadFile:async()=>{throw Error('download failed');}}:{extractFile:async(_zip,folder)=>program(folder,'0.2.0')});
  await assert.rejects(f.manager.install());assert.equal(f.data().path,f.exe);assert.equal(f.data().pending,undefined);
  assert.deepEqual(await fs.readdir(path.join(f.directory,'cadensview','versions')),[]);
 }
});
test('choosing a valid program cancels pending switch; unknown executable rejected',async t=>{
 const f=await fixture(t);f.manager.save({pending:{path:'old'}});await assert.rejects(f.manager.configure({path:path.join(f.directory,'bad.exe')}),/CadensView/);
 await f.manager.configure({path:f.exe});assert.equal(f.data().pending,null);
});
test('lost pending update falls back to existing executable without blocking appreciation',async t=>{
 const f=await fixture(t);f.manager.save({pending:{path:path.join(f.directory,'missing','CadensView.exe'),version:'0.3.0'}});
 await f.manager.open(f.video);assert.equal(f.launched[0].exe,f.exe);assert.equal(f.data().pending,null);assert.ok(f.events.some(e=>e.event==='warning'));
});
test('IPC rejects arbitrary files and allows only the selected work registered version',async t=>{
 const f=await fixture(t),handlers=new Map(),cleanup=[];
 const nativeRequire=require('node:module').createRequire(path.resolve(__dirname,'../js/cadensview-main.cjs'));
 const mod={exports:{}};
 const source=await fs.readFile(path.resolve(__dirname,'../js/cadensview-main.cjs'),'utf8');
 new Function('require','module','exports','__dirname',source)(name=>name==='electron'?{BrowserWindow:{getAllWindows:()=>[]},dialog:{}}:nativeRequire(name),mod,mod.exports,path.resolve(__dirname,'../js'));
 const manager=mod.exports.register({versionsRoot:path.join(f.directory,'cadensview','versions'),ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn)},app:{getPath:()=>f.directory,once:(_e,fn)=>cleanup.push(fn)},sysdata:f.manager.store,getWork:id=>{if(id!=='WorkSaveNo1')throw Error('番剧不存在');return {RenameBinding:{files:[{path:f.video}]}};}});
 t.after(()=>cleanup.forEach(fn=>fn()));manager.launchFile=async()=>{};manager.save({automatic:false});
 const open=handlers.get('cadensview:open');await assert.rejects(open(null,{id:'WorkSaveNo1',path:path.join(f.directory,'other.mkv')}),/已登记/);
 await assert.rejects(open(null,{id:'WorkSaveNo1',path:'relative.mkv'}),/已登记/);await assert.rejects(open(null,{id:'WorkSaveNo2',path:f.video}),/不存在/);
 assert.equal((await open(null,{id:'WorkSaveNo1',path:f.video})).alreadyOpen,false);
});
test('safe ZIP extraction supports Unicode paths and rejects traversal before writing', {skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),zip=path.join(f.directory,'test.zip');
 const make=async name=>run('python',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],"fixture"); z.close()',zip,name]);
 await make('目录/CadensView.exe');const dest=path.join(f.directory,'safe');await extract(zip,dest);assert.equal(await fs.readFile(path.join(dest,'目录','CadensView.exe'),'utf8'),'fixture');
 await make('../escape.exe');const unsafe=path.join(f.directory,'unsafe');await assert.rejects(extract(zip,unsafe));await assert.rejects(fs.access(path.join(f.directory,'escape.exe')));await assert.rejects(fs.access(unsafe));
});
function releaseAt(v){return releaseInfo({tag_name:'v'+v,assets:[{name:`CadensView-${v}-win-x64.zip`,browser_download_url:`https://github.com/dddkkw/CadensView/releases/download/v${v}/CadensView-${v}-win-x64.zip`}]});}
test('updates roll over two managed versions; rollback retains both; external installation survives',async t=>{
 let next='0.2.0';const f=await fixture(t,{latest:async()=>releaseAt(next),extractFile:async(_zip,folder)=>program(folder,next)});
 await f.manager.install();const v2=f.data().path;
 next='0.3.0';await f.manager.install();const v3=f.data().path;
 next='0.4.0';await f.manager.install();const v4=f.data().path;
 assert.equal((await fs.readdir(path.join(f.directory,'cadensview','versions'))).length,2);
 await assert.rejects(fs.access(v2));await fs.access(v3);await fs.access(v4);await fs.access(f.exe);
 assert.equal((await f.manager.rollback()).path,v3);await fs.access(v4);
 next='0.5.0';await f.manager.install();await assert.rejects(fs.access(v4));await fs.access(v3);assert.equal(f.data().previous.path,v3);
});
test('pending update keeps rollback until activation, and running program prevents cleanup',async t=>{
 let next='0.2.0',busy=false;const f=await fixture(t,{latest:async()=>releaseAt(next),extractFile:async(_zip,folder)=>program(folder,next),isRunning:async()=>busy});
 await f.manager.install();const v2=f.data().path;next='0.3.0';await f.manager.install();const v3=f.data().path;
 busy=true;next='0.4.0';await f.manager.install();const root=path.join(f.directory,'cadensview','versions');
 await f.manager.pruneVersions();assert.equal((await fs.readdir(root)).length,3);assert.equal(f.data().path,v3);await fs.access(v2);
 busy=false;await f.manager.applyPending();assert.equal((await fs.readdir(root)).length,2);await assert.rejects(fs.access(v2));await fs.access(v3);
});
test('cleanup ignores arbitrary folders, incomplete installs and directory links',async t=>{
 const f=await fixture(t),root=path.join(f.directory,'cadensview','versions');await fs.mkdir(root,{recursive:true});
 const uuid=require('node:crypto').randomUUID;
 const managed=path.join(root,'0.0.1-'+uuid());const old=await program(managed,'0.0.1');
 const foreign=path.join(root,'personal-files');await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,'notes.txt'),'keep');
 const partial=path.join(root,'0.0.2-'+uuid());await fs.mkdir(partial);await fs.writeFile(path.join(partial,'data.txt'),'keep');
 const outside=path.join(f.directory,'outside');await program(outside,'0.0.3');const link=path.join(root,'0.0.3-'+uuid());await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
 await f.manager.pruneVersions();await assert.rejects(fs.access(old));await fs.access(foreign);await fs.access(partial);await fs.access(link);await fs.access(outside);
});
test('cleanup errors preserve the active version and retry on the next idle pass',async t=>{
 const f=await fixture(t);let fail=true;f.manager.doPruneVersions=async()=>{if(fail)throw Error('file busy');if(f.manager.config().cleanupError)f.manager.save({cleanupError:''});};
 await f.manager.pruneVersions();assert.match(f.data().cleanupError,/file busy/);assert.equal(f.data().path,f.exe);await fs.access(f.exe);
 fail=false;await f.manager.pruneVersions();assert.equal(f.data().cleanupError,'');
});
test('Windows startup rejects physically long paths and accepts a physically short installation', {skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t);
 const longExe=await program(path.join(f.directory,'nested-'.repeat(22)),'0.3.0');
 await assert.rejects(prepareLaunchExecutable(longExe),/路径过长/);assert.equal(await prepareLaunchExecutable(f.exe),f.exe);
 assert.equal(await prepareLaunchExecutable(longExe,{platform:'linux'}),longExe);
});
test('a short directory link cannot hide a long worker runtime path', {skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),longExe=await program(path.join(f.directory,'nested-'.repeat(22)),'0.3.0');
 const alias=path.join(f.directory,'alias');await fs.symlink(path.dirname(longExe),alias,'junction');await assert.rejects(prepareLaunchExecutable(path.join(alias,'CadensView.exe')),/路径过长/);
});
test('cleanup retains an active managed package selected through a directory link', {skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),root=path.join(f.directory,'cadensview','versions'),managed=path.join(root,'0.3.0-'+require('node:crypto').randomUUID());
 const exe=await program(managed,'0.3.0'),alias=path.join(f.directory,'current');await fs.symlink(path.dirname(exe),alias,'junction');
 f.manager.save({path:path.join(alias,'CadensView.exe')});await f.manager.pruneVersions();await fs.access(exe);await fs.access(path.join(alias,'CadensView.exe'));
});
test('appreciation launches a visible GUI with the short entry and exact video argument',async()=>{
 const {EventEmitter}=require('node:events');let actual,unreferenced=false,exited=false;
 const child=await launch('original/CadensView.exe','中文 视频.mkv',()=>{exited=true;},{prepare:async()=>path.resolve('short/CadensView.exe'),spawnProcess:(exe,args,options)=>{
  actual={exe,args,options};const process=new EventEmitter();process.unref=()=>{unreferenced=true;};queueMicrotask(()=>process.emit('spawn'));return process;
 }});
 assert.equal(actual.exe,path.resolve('short/CadensView.exe'));assert.deepEqual(actual.args,['中文 视频.mkv']);assert.equal(actual.options.windowsHide,false);assert.equal(actual.options.cwd,path.resolve('short'));assert.equal(unreferenced,true);child.emit('exit',0);assert.equal(exited,true);
});
test('managed updates use the requested root with a flat package layout and retain two versions',async t=>{
 assert.equal(VERSIONS_ROOT,'F:\\softwares\\CadensView\\versions');
 const f=await fixture(t);const softwareRoot=path.join(f.directory,'software','CadensView','versions');f.manager.versionsRoot=softwareRoot;
 await f.manager.install();assert.equal(path.dirname(path.dirname(f.data().path)),softwareRoot);assert.equal(path.basename(f.data().path),'CadensView.exe');
 await assert.rejects(fs.access(path.join(f.directory,'cadensview','versions')));
});
test('manual color default is backed up, applied once and covers startup and project changes',async t=>{
 const f=await fixture(t),qml=path.join(path.dirname(f.exe),'_internal','shotlab','Main.qml'),original=await fs.readFile(qml,'utf8');
 await applyAnalysisDefaults(f.exe);const patched=await fs.readFile(qml,'utf8');assert.equal(await fs.readFile(qml+'.bgm-original','utf8'),original);
 assert.match(patched,/Component.onCompleted: Qt.callLater\(function\(\) \{ workspace.statistics.cancelColors\(\);/);assert.match(patched,/function onProjectChanging\(\) \{\s+Qt.callLater\(function\(\) \{ window.workspace.statistics.cancelColors\(\);/);
 await applyAnalysisDefaults(f.exe);assert.equal(await fs.readFile(qml,'utf8'),patched);
});
test('newly installed versions keep color analysis manual; unsupported QML remains untouched',async t=>{
 const f=await fixture(t);const result=await f.manager.install();const qml=path.join(path.dirname(result.path),'_internal','shotlab','Main.qml');assert.match(await fs.readFile(qml,'utf8'),/bgm.res: manual color analysis/);
 await fs.writeFile(qml,'UnknownWindow {}');await assert.rejects(applyAnalysisDefaults(result.path),/无法应用/);assert.equal(await fs.readFile(qml,'utf8'),'UnknownWindow {}');
});
test('an existing early color preference upgrades from its original QML backup',async t=>{
 const f=await fixture(t),qml=path.join(path.dirname(f.exe),'_internal','shotlab','Main.qml'),original=await fs.readFile(qml,'utf8');
 await fs.writeFile(qml+'.bgm-original',original);await fs.writeFile(qml,'// bgm.res: manual color analysis\nApplicationWindow {\nComponent.onCompleted: workspace.statistics.cancelColors()\n}');
 await applyAnalysisDefaults(f.exe);const patched=await fs.readFile(qml,'utf8');assert.match(patched,/manual color analysis v2/);assert.match(patched,/Qt.callLater/);assert.equal(await fs.readFile(qml+'.bgm-original','utf8'),original);
});
