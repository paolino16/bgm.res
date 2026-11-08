'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const {createHash}=require('node:crypto');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {episodePath,subtitleGroup}=require('./desktop-actions.cjs');
const key=file=>path.resolve(file).toLowerCase();

function regularPlaylist(work,current){
  const known=new Map((work.RenameBinding?.files||[]).map(file=>[key(file.path),file.availability]));
  const candidates=slot=>[...new Map([{path:episodePath(work,slot)},...(slot.Versions||[])]
    .filter(file=>file.path).map(file=>[key(file.path),file])).values()];
  const slots=Object.entries(work.EPDetails||{}).filter(([,slot])=>!slot.Collection&&(slot.EpisodeType==null||Number(slot.EpisodeType)===0))
    .sort((a,b)=>Number(a[1].EpisodeNumber??a[1].LocalIndex??a[0].slice(2))-Number(b[1].EpisodeNumber??b[1].LocalIndex??b[0].slice(2)));
  if(!slots.some(([,slot])=>candidates(slot).some(file=>key(file.path)===key(current))))return [current];
  const group=subtitleGroup(work,current).toLowerCase(),files=[],seen=new Set();
  for(const [,slot]of slots){
    const versions=candidates(slot),chosen=versions.find(file=>key(file.path)===key(current))||versions.find(file=>{
      const status=file.availability||known.get(key(file.path))||slot.availability;
      return (!status||status==='available')&&subtitleGroup(work,file.path).toLowerCase()===group;
    });
    if(chosen&&!seen.has(key(chosen.path))){seen.add(key(chosen.path));files.push(chosen.path);}
  }
  const start=files.findIndex(file=>key(file)===key(current));
  return start<0?[current]:[...files.slice(start),...files.slice(0,start)];
}

function registryValue(stdout){return stdout.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/)?.[1]?.trim()||'';}
async function associatedPlayer(file,{run=promisify(execFile)}={}){
  const extension=path.extname(file);if(!/^\.[a-z0-9]+$/i.test(extension))return null;
  const query=async(registry,args)=>registryValue((await run('reg.exe',['query',registry,...args],{windowsHide:true,timeout:3000})).stdout);
  let progId;
  try{progId=await query('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\'+extension+'\\UserChoice',['/v','ProgId']);}catch{}
  if(!progId)try{progId=await query('HKCR\\'+extension,['/ve']);}catch{}
  if(!progId)return null;
  try{
    const command=await query('HKCR\\'+progId+'\\shell\\open\\command',['/ve']);
    const executable=command.match(/^"([^"]+\.exe)"(?:\s|$)/i)?.[1]||command.match(/^(.+?\.exe)(?:\s|$)/i)?.[1];
    return executable?.replace(/%([^%]+)%/g,(value,name)=>process.env[name]||value)||null;
  }catch{return null;}
}

function launchPlayer(executable,playlist){return new Promise((resolve,reject)=>{
  const child=spawn(executable,[playlist],{detached:true,stdio:'ignore',windowsHide:true});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
});}

async function play({work,file,directory,shell,platform=process.platform,resolvePlayer=associatedPlayer,launch=launchPlayer}){
  const selected=await fs.stat(file);if(!selected.isFile()||!selected.size)throw Error('视频不存在或为空文件，无法播放');
  const files=(await Promise.all(regularPlaylist(work,file).map(async file=>{
    try{const stat=await fs.stat(file);return stat.isFile()&&stat.size?file:null;}catch{return null;}
  }))).filter(Boolean);
  if(files.length<=1){const error=await shell.openPath(file);if(error)throw Error(error);return {files:[file]};}
  if(files.some(file=>/[\r\n]/.test(file)))throw Error('文件名包含换行，无法生成播放列表');
  const content='\uFEFF#EXTM3U\r\n'+files.map(file=>path.resolve(file)).join('\r\n')+'\r\n';
  const folder=path.join(directory,'playlists');await fs.mkdir(folder,{recursive:true});
  const playlist=path.join(folder,createHash('sha256').update(content).digest('hex')+'.m3u8');
  await fs.writeFile(playlist,content,'utf8');
  // Playlist extensions may belong to a different player than the video itself.
  const player=platform==='win32'?await resolvePlayer(file):null;
  if(player)await launch(player,playlist);
  else{const error=await shell.openPath(playlist);if(error)throw Error(error);}
  return {files,playlist};
}
module.exports={regularPlaylist,associatedPlayer,play};
