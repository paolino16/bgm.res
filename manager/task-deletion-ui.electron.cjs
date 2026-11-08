// Isolated organizer UI: mocked IPC, no access to the user's records or media.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.desktop','task-deletion-ui-qa');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1150,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}});
 const run=code=>win.webContents.executeJavaScript(code),pause=()=>new Promise(resolve=>setTimeout(resolve,100));
 const checks=[];
 async function check(name,code){assert.equal(await run(code),true,name);checks.push(name);}
 const styles=['library-desktop.css','library-themes.css','library-polish.css','library-chrome.css'].map(name=>`<link rel="stylesheet" href="../includes/${name}">`).join('');
 const html=path.join(out,'fixture.html');
 fs.writeFileSync(html,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>删除任务验证</title>${styles.replaceAll('../includes/','../../includes/')}<body data-theme="codex-dark" data-view="organizer"><main id="content" style="position:static;margin:0;padding:28px;height:100vh;overflow:auto"></main></body></html>`);
 try{
  await win.loadFile(html);
  await run(`
   window.calls=[];window.messages=[];window.jobs=new Map();window.sequence=0;window.failPreview=false;
   window.appearance=require(${JSON.stringify(path.join(root,'js','desktop-appearance.cjs'))});appearance.applyTheme(document,'codex-dark');
   const task={uuid:'fixture',name:'异国日记 · 字幕组版本',path:'D:/ANIME/TV/异国日记 (2026)',plan_state:'completed'};
   const ipc={invoke:async(channel,payload)=>{
    if(channel==='library:organize')return {tasks:[task],jobs:[]};
    if(channel==='organizer:job')return jobs.get(payload);
    if(channel==='organizer:action'){
     calls.push(payload);const options=payload.body;
     const result=payload.action==='delete-task-preview'?{id:task.uuid,name:task.name,source:task.path,delete_outputs:options.delete_outputs,delete_sources:options.delete_sources===true,token:'fixture-token',source_count:options.delete_sources?1:0,trash_count:(options.delete_outputs?1:0)+(options.delete_sources?1:0),keep_count:options.delete_outputs?0:1,cleanup_roots:[],rows:[{path:'D:/ANIME/TV-media/异国日记 (2026)/异国日记 EP01 [LoliHouse&喵萌奶茶屋].mkv',kind:'output',reason:options.delete_outputs?'移入回收站':'保留输出文件'},...(options.delete_sources?[{path:task.path+'/Season 1/[LoliHouse&喵萌奶茶屋] 异国日记 (2026) S01E01.mkv',kind:'source',reason:'移入回收站'}]:[])]}:{message:'模拟删除完成'};
     const id=String(++sequence);jobs.set(id,{id,state:failPreview&&payload.action==='delete-task-preview'?'failed':'completed',error:'预览失败，请重试',result});return {job_id:id};
    }throw Error(channel);
   }};
   const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
   const button=(text,click,cls)=>{const el=node('button',cls,text);el.onclick=click;return el;};
   const ui=require(${JSON.stringify(path.join(root,'js','organizer-desktop.cjs'))}).create({ipc,node,button,notice:text=>messages.push(text),setHeader:()=>{},container:()=>document.querySelector('#content'),isActive:()=>true});
   ui.render();window.ui=ui;
   window.clickText=text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text).click();
   void 0;
  `);await pause();
  await run(`clickText('删除记录 / 关联文件')`);await pause();
  await check('both deletion options default off',`document.querySelectorAll('input[type=checkbox]').length===2 && [...document.querySelectorAll('input[type=checkbox]')].every(input=>!input.checked)`);
  await run(`document.querySelectorAll('input[type=checkbox]')[1].click()`);await pause();
  await check('originals can be selected independently',`calls.at(-1).body.delete_sources===true && calls.at(-1).body.delete_outputs===false && document.querySelector('table').textContent.includes('原文件') && document.body.textContent.includes('1 个原文件')`);
  await run(`failPreview=true;document.querySelectorAll('input[type=checkbox]')[0].click()`);await pause();
  await check('failed preview restores reviewed options',`!document.querySelectorAll('input[type=checkbox]')[0].checked && document.querySelectorAll('input[type=checkbox]')[1].checked && messages.at(-1).includes('预览失败')`);
  await run(`failPreview=false;document.querySelectorAll('input[type=checkbox]')[0].click()`);await pause();
  await run(`clickText('刷新删除清单')`);await pause();
  await check('refresh preserves both selected options',`calls.at(-1).body.delete_sources===true && calls.at(-1).body.delete_outputs===true && document.body.textContent.includes('可能已无可用副本')`);
  for(const [theme,width]of [['codex-dark',1150],['codex-light',760]]){
   win.setSize(width,900);await run(`appearance.applyTheme(document,${JSON.stringify(theme)});void 0;`);await pause();
   await check(theme+' has no horizontal overflow',`document.documentElement.scrollWidth<=innerWidth`);
   fs.writeFileSync(path.join(out,theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  await run(`clickText('确认删除记录并回收 2 个文件')`);await pause();
  await check('confirmation submits reviewed options and token',`calls.filter(call=>call.action==='delete-task').some(call=>call.body.token==='fixture-token'&&call.body.delete_sources===true&&call.body.delete_outputs===true)`);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({checks},null,2));console.log(JSON.stringify({checks}));
 }catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0);}
});
