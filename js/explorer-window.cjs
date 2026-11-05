const fs=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process');
async function openExplorer({file,reveal=false,shell,focus=focusFolder}){
  const stat=await fs.stat(file);
  if(!reveal&&!stat.isDirectory())throw Error('请选择文件夹');
  const folder=reveal?path.dirname(file):file;
  if(reveal)shell.showItemInFolder(file);
  else{const error=await shell.openPath(folder);if(error)throw Error(error);}
  await focus(folder);
}
async function focusFolder(folder){
  if(process.platform!=='win32')return;
  const folders=[folder,await fs.realpath(folder)];
  await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'explorer-foreground.ps1')],{
    windowsHide:true,timeout:10000,env:{...process.env,BGM_EXPLORER_FOLDERS:JSON.stringify(folders)}
  },error=>error?reject(Error('文件夹已打开，但无法切到前台，请点击任务栏中的资源管理器')):resolve()));
}
module.exports={openExplorer,focusFolder};
