'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),https=require('node:https');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const {createHash,randomUUID}=require('node:crypto');
const run=promisify(execFile);
const DEFAULT_EXE='F:\\softwares\\CadensView-0.1.0-win-x64\\CadensView.exe';
const VERSIONS_ROOT='F:\\softwares\\CadensView\\versions';
const RELEASES='https://github.com/dddkkw/CadensView/releases';
function version(value){return String(value||'').match(/^v?(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)||null;}
function newer(a,b){const x=version(a),y=version(b);if(!x)return false;if(!y)return true;for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;}
function allowedURL(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!['github.com','api.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('更新地址不是受支持的 GitHub 地址');return u;}
function response(url,redirects=0){return new Promise((resolve,reject)=>{
  if(redirects>6)return reject(Error('更新下载重定向过多'));
  let target;try{target=allowedURL(url);}catch(e){reject(e);return;}
  const req=https.get(target,{headers:{'User-Agent':'bgm.res-CadensView','Accept':'application/vnd.github+json'}},res=>{
    if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.resume();response(new URL(res.headers.location,target).href,redirects+1).then(resolve,reject);return;}
    if(res.statusCode!==200){res.resume();reject(Error('GitHub 请求失败（'+res.statusCode+'），请稍后重试'));return;}
    resolve({stream:res,url:target.href});
  });
  req.setTimeout(30000,()=>req.destroy(Error('连接 GitHub 超时，请检查网络后重试')));req.on('error',reject);
});}
async function textURL(url){const {stream,url:finalURL}=await response(url);let size=0;const chunks=[];for await(const part of stream){size+=part.length;if(size>3*1024*1024){stream.destroy();throw Error('更新信息过大');}chunks.push(part);}return {text:Buffer.concat(chunks).toString('utf8'),url:finalURL};}
function releaseInfo(raw){
  if(raw.draft||raw.prerelease||!version(raw.tag_name))throw Error('未找到正式版本');
  const v=raw.tag_name.replace(/^v/,'');
  const asset=(raw.assets||[]).find(a=>a.name===`CadensView-${v}-win-x64.zip`);
  if(!asset)throw Error('新版尚未提供 Windows x64 便携包');
  const expected=`${RELEASES}/download/${raw.tag_name}/${asset.name}`;
  if(asset.browser_download_url!==expected)throw Error('便携包下载地址与版本不符');
  return {version:v,url:`${RELEASES}/tag/${raw.tag_name}`,notes:String(raw.body||'').slice(0,20000),asset:{name:asset.name,url:expected,size:Number(asset.size)||0,digest:/^sha256:[a-f0-9]{64}$/i.test(asset.digest||'')?asset.digest:null}};
}
async function latestRelease(){
  try{return releaseInfo(JSON.parse((await textURL('https://api.github.com/repos/dddkkw/CadensView/releases/latest')).text));}
  catch(apiError){
    // GitHub's shared anonymous API quota can be exhausted; use its official release pages.
    const page=await textURL(RELEASES+'/latest');const tag=new URL(page.url).pathname.split('/').pop();
    if(!version(tag))throw apiError;
    const v=tag.replace(/^v/,''),name=`CadensView-${v}-win-x64.zip`;
    const assets=await textURL(RELEASES+'/expanded_assets/'+tag);
    const relative=`/dddkkw/CadensView/releases/download/${tag}/${name}`;
    if(!assets.text.includes('href="'+relative+'"'))throw Error('新版尚未提供 Windows x64 便携包');
    return releaseInfo({tag_name:tag,body:'更新说明请查看发布页面。',assets:[{name,browser_download_url:'https://github.com'+relative}]});
  }
}
async function download(asset,file,onProgress){
  const {stream}=await response(asset.url);const total=Number(stream.headers['content-length'])||asset.size;
  let received=0,last=0;const hash=createHash('sha256');
  const meter=new Transform({transform(chunk,encoding,done){received+=chunk.length;hash.update(chunk);if(received>3*1024**3)return done(Error('更新包超过 3 GiB 限制'));if(Date.now()-last>500){last=Date.now();onProgress({received,total});}done(null,chunk);}});
  const timer=setTimeout(()=>stream.destroy(Error('更新包下载超时，请重试')),20*60*1000);timer.unref();
  try{await pipeline(stream,meter,require('node:fs').createWriteStream(file,{flags:'wx'}));}finally{clearTimeout(timer);}
  if(asset.size&&received!==asset.size)throw Error('更新包下载不完整');
  if(asset.digest&&'sha256:'+hash.digest('hex')!==asset.digest.toLowerCase())throw Error('更新包校验失败，请重新下载');
  onProgress({received,total});
}
async function executableInfo(executable){
  if(typeof executable!=='string'||!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!=='cadensview.exe')throw Error('请选择 CadensView.exe');
  const stat=await fs.stat(executable).catch(()=>{throw Error('CadensView 不存在，请在偏好设置中选择程序');});
  if(!stat.isFile()||!stat.size)throw Error('CadensView 程序无效');
  let current='';try{current=JSON.parse(await fs.readFile(path.join(path.dirname(executable),'BUILD-MANIFEST.json'),'utf8')).version;}catch{}
  return {path:executable,version:version(current)?current:(path.dirname(executable).match(/CadensView-(\d+\.\d+\.\d+)-win-x64/i)?.[1]||'')};
}
async function extract(zip,destination){
  await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'cadensview-extract.ps1')],{windowsHide:true,timeout:10*60*1000,env:{...process.env,BGM_CADENS_ZIP:zip,BGM_CADENS_DEST:destination}});
}
async function findExecutable(folder,depth=0){
  const direct=path.join(folder,'CadensView.exe');try{await fs.access(direct);return direct;}catch{}
  if(depth>=2)throw Error('更新包内没有找到 CadensView.exe');
  const dirs=(await fs.readdir(folder,{withFileTypes:true})).filter(e=>e.isDirectory());
  if(dirs.length!==1)throw Error('无法识别更新包的程序目录');return findExecutable(path.join(folder,dirs[0].name),depth+1);
}
async function running(){
  const {stdout}=await run('tasklist.exe',['/FI','IMAGENAME eq CadensView.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:10000});
  return /^"CadensView\.exe"/im.test(stdout);
}
const QML_PLUGIN=path.join('_internal','PySide6','qml','QtQuick','Controls','Basic','impl','qtquickcontrols2basicstyleimplplugin.dll');
async function prepareLaunchExecutable(exe,{platform=process.platform}={}){
  // Qt and its analysis workers must use a physically short path, not a directory link.
  if(platform==='win32'&&path.join(path.dirname(await fs.realpath(exe)),QML_PLUGIN).length>=240)throw Error('鉴赏程序路径过长，请选择 F:\\softwares\\CadensView 下的程序');
  return exe;
}
async function applyAnalysisDefaults(exe){
  const file=path.join(path.dirname(exe),'_internal','shotlab','Main.qml');
  let source=await fs.readFile(file,'utf8');
  const marker='// bgm.res: manual color analysis v2';
  if(source.includes(marker))return;
  const backup=file+'.bgm-original';
  if(source.includes('// bgm.res: manual color analysis'))source=await fs.readFile(backup,'utf8');
  const root=/ApplicationWindow\s*\{\s*\r?\n/;
  const project=/function onProjectChanging\(\)\s*\{/;
  if(!root.test(source)||!project.test(source)||/Component\.onCompleted\s*:/.test(source))throw Error('此版 CadensView 无法应用手动色彩分析偏好，请检查版本');
  // Project teardown resets the statistics service after projectChanging is emitted.
  // Defer until that synchronous teardown finishes, before its timers can start colors.
  const modified=source.replace(root,match=>match+'    '+marker+'\n    Component.onCompleted: Qt.callLater(function() { workspace.statistics.cancelColors(); })\n')
    .replace(project,match=>match+'\n            Qt.callLater(function() { window.workspace.statistics.cancelColors(); });');
  try{await fs.writeFile(backup,source,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
  await fs.writeFile(file,modified);
}
async function launch(exe,file,onExit,{spawnProcess=spawn,prepare=prepareLaunchExecutable}={}){
 const entry=await prepare(exe);
 return new Promise((resolve,reject)=>{
  const child=spawnProcess(entry,[file],{cwd:path.dirname(entry),detached:true,stdio:'ignore',windowsHide:false});
  child.once('error',reject);child.once('exit',onExit);child.once('spawn',()=>{child.unref();resolve(child);});
 });
}
class CadensView {
  constructor({store,directory,versionsRoot=path.join(directory,'cadensview','versions'),notify=()=>{},latest=latestRelease,downloadFile=download,extractFile=extract,isRunning=running,launchFile=launch}){
    Object.assign(this,{store,directory,versionsRoot,notify,latest,downloadFile,extractFile,isRunning,launchFile});this.active=new Set();this.launches=new Map();this.progress=null;
  }
  config(){return {path:DEFAULT_EXE,automatic:true,...this.store.get('CadensView',{})};}
  save(changes){this.store.set('CadensView',{...this.config(),...changes});}
  async status(){const cfg=this.config();let info;try{info=await executableInfo(cfg.path);}catch(e){info={path:cfg.path,version:'',error:e.message};}return {...info,automatic:cfg.automatic,latest:cfg.latest,pending:cfg.pending,previous:cfg.previous,checkedAt:cfg.checkedAt,checkError:cfg.checkError||'',cleanupError:cfg.cleanupError||'',progress:this.progress};}
  pruneVersions(){
    if(this.pruning)return this.pruning;
    this.pruning=this.doPruneVersions().catch(error=>{
      const message='旧版清理失败，将稍后重试：'+error.message;
      if(this.config().cleanupError!==message)this.notify({event:'warning',message});
      this.save({cleanupError:message});
    }).finally(()=>{this.pruning=null;});return this.pruning;
  }
  async doPruneVersions(){
    // A pending update temporarily needs three slots: current, rollback, and candidate.
    if(this.installing||this.config().pending)return;
    const root=path.resolve(this.versionsRoot);
    const stat=await fs.lstat(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!stat)return;
    if(await this.isRunning())return;
    const identity=value=>path.resolve(value).toLowerCase();
    if(!stat.isDirectory()||stat.isSymbolicLink()||identity(await fs.realpath(root))!==identity(root))throw Error('版本目录不是受管理的普通目录');
    for(const entry of await fs.readdir(root,{withFileTypes:true})){
      // Only the updater's version/UUID directories are owned by us; never touch arbitrary folders.
      const match=entry.name.match(/^(\d+\.\d+\.\d+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
      if(!match||!entry.isDirectory()||entry.isSymbolicLink())continue;
      const candidate=path.join(root,entry.name),resolved=await fs.realpath(candidate);
      if(identity(path.dirname(resolved))!==identity(root)||identity(resolved)!==identity(candidate))continue;
      const cfg=this.config();if(this.installing||cfg.pending)return;
      const references=[cfg.path,cfg.previous?.path].filter(Boolean);
      const realReferences=await Promise.all(references.map(file=>fs.realpath(file).catch(()=>file)));
      const retained=[...references,...realReferences].some(file=>{const relative=path.relative(candidate,path.resolve(file));return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));});
      if(retained)continue;
      // Existing installs also qualify, but incomplete or foreign directories are left alone.
      let exe,manifest;try{exe=await findExecutable(candidate);manifest=JSON.parse(await fs.readFile(path.join(path.dirname(exe),'BUILD-MANIFEST.json'),'utf8'));}catch{continue;}
      if(manifest.version!==match[1])continue;
      const latest=this.config();if(this.installing||latest.pending||latest.path!==cfg.path||latest.previous?.path!==cfg.previous?.path)return;
      // The absolute target has been checked to be a direct, non-link child of our version root.
      await fs.rm(resolved,{recursive:true,force:true});
    }
    if(this.config().cleanupError)this.save({cleanupError:''});
  }
  async configure(changes){
    if(this.installing)throw Error('更新正在进行，请完成后再修改设置');
    const allowed={};if(Object.hasOwn(changes,'path')){allowed.path=(await executableInfo(changes.path)).path;allowed.pending=null;}
    if(Object.hasOwn(changes,'automatic'))allowed.automatic=Boolean(changes.automatic);this.save(allowed);return this.status();
  }
  check(force=false){
    if(this.checking)return this.checking;
    const cfg=this.config();if(!force&&(!cfg.automatic||Date.now()-(cfg.checkedAt||0)<24*60*60*1000))return Promise.resolve(null);
    // Persist attempts too, so an offline launch does not repeatedly hit GitHub.
    this.save({checkedAt:Date.now(),checkError:''});
    this.checking=(async()=>{try{const latest=await this.latest();this.save({latest,checkError:''});const current=await this.status();this.notify({...current,event:'checked',available:newer(latest.version,current.version)});return current;}
      catch(e){this.save({checkError:e.message});if(force)throw e;return null;}
      finally{this.checking=null;}})();return this.checking;
  }
  async applyPending(){
    const cfg=this.config();if(!cfg.pending)return false;
    if(await this.isRunning())return false;
    const info=await executableInfo(cfg.pending.path);if(info.version!==cfg.pending.version)throw Error('待切换版本验证失败，请重新下载');
    this.save({path:info.path,previous:{path:cfg.path},pending:null});await this.pruneVersions();this.notify({...await this.status(),event:'switched'});return true;
  }
  async open(file){
    const key=path.resolve(file).toLowerCase();
    if(this.launches.has(key))return this.launches.get(key);
    const operation=(async()=>{
      if(this.active.has(key))return {alreadyOpen:true};
      const stat=await fs.stat(file);if(!stat.isFile()||!stat.size)throw Error('视频不存在或为空文件，无法鉴赏');
      try{await this.applyPending();}catch(error){this.save({pending:null});this.notify({event:'warning',message:'新版切换失败，继续使用当前版本：'+error.message});}
      const info=await executableInfo(this.config().path);
      await applyAnalysisDefaults(info.path);
      this.active.add(key);
      try{await this.launchFile(info.path,file,()=>{this.active.delete(key);this.applyPending().catch(()=>{});});}catch(e){this.active.delete(key);throw e;}
      // Never block opening a video on network requests.
      void this.check().catch(()=>{});return {alreadyOpen:false};
    })();
    this.launches.set(key,operation);try{return await operation;}finally{this.launches.delete(key);}
  }
  install(){
    if(this.installing)return this.installing;
    this.installing=this.doInstall().finally(async()=>{this.installing=null;this.progress=null;await this.pruneVersions();});return this.installing;
  }
  async doInstall(){
    await this.check(true);const cfg=this.config(),release=cfg.latest,info=await this.status();
    if(!release||!newer(release.version,info.version))throw Error('当前没有可安装的新版');
    const root=path.resolve(this.versionsRoot);await fs.mkdir(root,{recursive:true});
    const stage=path.join(root,'.download-'+randomUUID());await fs.mkdir(stage);
    const zip=path.join(stage,'package.zip'),unpacked=path.join(stage,'unpacked');
    const report=progress=>{this.progress=progress;this.notify({...progress,event:'progress'});};
    report({phase:'download',received:0,total:release.asset.size});
    try{
      await this.downloadFile(release.asset,zip,value=>report({phase:'download',...value}));report({phase:'extract'});
      await this.extractFile(zip,unpacked);const exe=await findExecutable(unpacked),candidate=await executableInfo(exe);
      // Managed updates must contain their own manifest and runtime, not just an executable.
      const manifest=JSON.parse(await fs.readFile(path.join(path.dirname(exe),'BUILD-MANIFEST.json'),'utf8'));
      if(manifest.version!==release.version||candidate.version!==release.version)throw Error('更新包版本不符');
      if(!(await fs.stat(path.join(path.dirname(exe),'_internal'))).isDirectory())throw Error('更新包缺少运行环境');
      await applyAnalysisDefaults(exe);
      const target=path.join(root,release.version+'-'+randomUUID());await fs.rename(path.dirname(exe),target);
      const finalExe=path.join(target,'CadensView.exe');
      this.save({pending:{path:finalExe,version:release.version}});
      await this.applyPending();this.progress=null;const state=await this.status();this.notify({...state,event:'installed'});return state;
    }finally{await fs.rm(stage,{recursive:true,force:true});}
  }
  async rollback(){
    if(this.installing)throw Error('更新正在进行，请稍后重试');
    if(await this.isRunning())throw Error('请先关闭 CadensView，再切换旧版');
    const cfg=this.config();if(!cfg.previous?.path)throw Error('没有可回退的旧版');
    await executableInfo(cfg.previous.path);this.save({path:cfg.previous.path,previous:{path:cfg.path},pending:null});await this.pruneVersions();return this.status();
  }
}
function register({ipcMain,app,sysdata,getWork,versionsRoot=VERSIONS_ROOT}){
  const {BrowserWindow,dialog}=require('electron');
  const manager=new CadensView({store:sysdata,directory:app.getPath('userData'),versionsRoot,notify:message=>{for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send('cadensview:update',message);}});
  ipcMain.handle('cadensview:status',()=>manager.status());
  ipcMain.handle('cadensview:configure',(_e,changes)=>manager.configure(changes));
  ipcMain.handle('cadensview:choose',async event=>{
    const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'选择 CadensView.exe',properties:['openFile'],filters:[{name:'CadensView',extensions:['exe']}]});
    return result.canceled?null:manager.configure({path:result.filePaths[0]});
  });
  ipcMain.handle('cadensview:check',()=>manager.check(true));
  ipcMain.handle('cadensview:install',()=>manager.install());
  ipcMain.handle('cadensview:apply',async()=>{await manager.applyPending();return manager.status();});
  ipcMain.handle('cadensview:rollback',()=>manager.rollback());
  ipcMain.handle('cadensview:open',async(_event,{id,path:target})=>{
    const work=getWork(id),core=require('./rename-binding-core.cjs');
    const registered=[...(work.RenameBinding?.files||[]),...(work.RenameBinding?.resources||[]),...['EPDetails','SPDetails'].flatMap(kind=>Object.values(work[kind]||{}).flatMap(slot=>[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))},...(slot.Versions||[])]))];
    if(typeof target!=='string'||!path.isAbsolute(target)||!registered.some(f=>f.path&&core.normalized(f.path)===core.normalized(target)))throw Error('只能鉴赏当前作品已登记的文件');
    return manager.open(target);
  });
  const maintain=()=>{if(!manager.installing)(manager.config().pending?manager.applyPending():manager.pruneVersions()).catch(()=>{});};
  maintain();const timer=setInterval(maintain,15000);timer.unref();
  app.once('will-quit',()=>clearInterval(timer));return manager;
}
module.exports={CadensView,register,newer,releaseInfo,executableInfo,latestRelease,download,findExecutable,extract,prepareLaunchExecutable,launch,VERSIONS_ROOT,applyAnalysisDefaults};
