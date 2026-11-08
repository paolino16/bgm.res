// Actual renderer/navigation with isolated IPC fixtures. No user data or credentials.
'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
require('@electron/remote/main').initialize();
const root=path.resolve(__dirname,'..'),out=path.join(root,'.desktop','subtitle-navigation-qa');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-accessibility');app.commandLine.appendSwitch('force-device-scale-factor','1');
const data={WorkSaveNo1:{WorkSaveNo:'WorkSaveNo1',ExistCondition:'Exist',Name:'淡岛百景',Year:'2026',Type:'TV',URL:'D:/fixture',
  EPDetails:{EP1:{Condition:'Unwatched',LocalIndex:1,URL:'01.mkv'},EP2:{Condition:'Unwatched',LocalIndex:2,URL:'02.mkv'}}}};
const videos=['D:/fixture/01.mkv','D:/fixture/02.mkv'];
const download={folder:'D:/fixture/download',archive:'D:/fixture/download/subtitles.rar',files:['D:/fixture/download/01.ass','D:/fixture/download/02.ass'],warning:''};
const calls=[],jobs=new Map(),checks=[],errors=[];let sequence=0,configured=false,limited=false,missingToken=false;
function handle(channel,fn){ipcMain.handle(channel,(_,body)=>{calls.push({channel,body});return fn(body);});}
handle('library:read',()=>data);handle('library:storage',()=>({directory:'fixture',renameData:'fixture'}));
handle('subtitles:progress',()=>({running:false}));handle('subtitles:details',()=>({summary:{status:'unknown'},files:videos.map(path=>({path,state:'checked'}))}));
handle('subtitle-inbox:list',()=>[]);
handle('subtitles:context',()=>({tasks:[{id:'fixture',files:videos}],chapters:[]}));
handle('library:organize',()=>({tasks:[],jobs:[]}));handle('media:duration',()=>({seconds:null}));handle('bangumi:request',()=>({status:503,error:'隔离测试'}));
handle('resources:settings',()=>({enabled:false,folder:'fixture',webui:{}}));handle('downloads:list',()=>({rows:[]}));
handle('discovery:status',()=>({username:'',revision:0}));handle('discovery:page',()=>({rows:[],total:0,count:0}));
handle('organizer:action',body=>{const job_id=String(++sequence);const result=body.action==='subtitle-versions'?{groups:[],videos}:body.action==='subtitle-preview'?{videos,rows:body.body.files.map((source,i)=>({source,video:videos[i%2],suffix:'ja',reason:'按集数识别'}))}:{videos,count:body.body.rows?.length||0};jobs.set(job_id,{state:'completed',result});return {job_id};});
handle('organizer:job',id=>jobs.get(id));
handle('subtitle-sources:settings',()=>({configured,persisted:configured}));
ipcMain.handle('subtitle-sources:configure',(_,value)=>{configured=Boolean(value);return {configured,persisted:configured};});
handle('subtitle-sources:search',async body=>{
  await new Promise(resolve=>setTimeout(resolve,80));
  if(body.source==='assrt'){if(missingToken)throw Error('请先配置射手网 API Token');if(limited)return {waiting:true,retryAt:Date.now()+60000};}
  return require('./subtitle-tabs-qa.cjs').searchResults(body);
});
handle('subtitle-sources:detail',async body=>{await new Promise(resolve=>setTimeout(resolve,80));return require('./subtitle-tabs-qa.cjs').detailResult(body);});
handle('subtitle-sources:download',async body=>{await new Promise(resolve=>setTimeout(resolve,80));return body.source==='assrt'&&body.fileId.startsWith('file:')?{...download,files:['D:/fixture/download/'+body.fileId.slice(5)]}:download;});
handle('subtitle-sources:folder',()=>{});handle('subtitle-sources:open',()=>{});
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1360,height:1000,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
  require('@electron/remote/main').enable(win.webContents);
  win.webContents.on('console-message',(_,level,message)=>{if(level===3)errors.push(message);});
  const js=code=>win.webContents.executeJavaScript(code),pause=()=>new Promise(resolve=>setTimeout(resolve,200));
  const click=text=>js(`[...document.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')===${JSON.stringify(text)}||el.textContent===${JSON.stringify(text)}).click()`);
  async function check(name,code){assert.equal(await js(code),true,name);checks.push(name);}
  async function shot(name){await pause();fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
  try{
    await require('./subtitle-tabs-qa.cjs').run({win,root,path,js,pause,click,check,shot,calls,download,setMissingToken:value=>{missingToken=value;},setLimited:value=>{limited=value;}});
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:true,checks,errors},null,2));assert.deepEqual(errors,[]);console.log(checks.length+' subtitle navigation checks passed');win.destroy();app.quit();
  }catch(error){fs.writeFileSync(path.join(out,'failure.txt'),error.stack);fs.writeFileSync(path.join(out,'errors.json'),JSON.stringify(errors));fs.writeFileSync(path.join(out,'failure-content.txt'),await js(`document.querySelector('#content').textContent`));fs.writeFileSync(path.join(out,'failure-calls.json'),JSON.stringify(calls,null,2));console.error(error);win.destroy();app.exit(1);}
});
