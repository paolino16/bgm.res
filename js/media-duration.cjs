const fs=require('node:fs/promises'),path=require('node:path');
const {normalized}=require('./rename-binding-core.cjs');
function positive(value){const n=Number(value);return Number.isFinite(n)&&n>0?n:null;}
function parseDuration(value){
  if(typeof value!=='string')return null;const text=value.trim();
  if(/^\d+:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)){
    const parts=text.split(':').map(Number);if(parts.slice(1).some(n=>n>=60))return null;
    return positive(parts.reduce((n,part)=>n*60+part,0));
  }
  const match=text.match(/^(?:(\d+(?:\.\d+)?)\s*(?:h|小时|時間)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:min(?:utes?)?|m|分钟|分鐘|分)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:sec(?:onds?)?|s|秒)\s*)?$/i);
  return match?positive(Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0)):null;
}
function bangumiDuration(episode){return positive(episode?.duration_seconds)||parseDuration(episode?.duration);}
function formatDuration(seconds){if(!positive(seconds))return '';const n=Math.round(seconds),s=String(n%60).padStart(2,'0'),m=Math.floor(n/60)%60;return n>=3600?Math.floor(n/3600)+':'+String(m).padStart(2,'0')+':'+s:Math.floor(n/60)+':'+s;}
class DurationIndex{
  constructor({directory,probeFile,resolveTool,sharedIndex=new Map()}){this.filename=path.join(directory,'duration-index.json');this.probeFile=probeFile;this.resolveTool=resolveTool;this.sharedIndex=sharedIndex;this.index=new Map();this.pending=new Map();this.active=0;this.waiters=[];this.saveQueue=Promise.resolve();}
  async load(){try{const saved=JSON.parse(await fs.readFile(this.filename,'utf8'));if(saved.version===1)this.index=new Map(Object.entries(saved.files||{}));}catch{}}
  save(){const value=JSON.stringify({version:1,files:Object.fromEntries(this.index)});const next=this.saveQueue.then(async()=>{await fs.writeFile(this.filename+'.tmp',value);await fs.rename(this.filename+'.tmp',this.filename);});this.saveQueue=next.catch(()=>{});return next;}
  async get(file){
    const key=normalized(file);if(this.pending.has(key))return this.pending.get(key);
    const task=(async()=>{
      if(this.active>=2)await new Promise(resolve=>this.waiters.push(resolve));this.active++;
      try{
        let stat;try{stat=await fs.stat(file);if(!stat.isFile()||!stat.size)return null;}catch{return null;}
        const signature=[stat.dev,stat.ino,stat.size,stat.mtimeMs].join(':');
        const shared=this.sharedIndex.get(key);if(shared?.signature===signature&&positive(shared.durationSeconds))return shared.durationSeconds;
        const old=this.index.get(key);if(old?.signature===signature)return old.durationSeconds;
        let durationSeconds=null;
        try{const tool=await(this.toolPromise||(this.toolPromise=this.resolveTool()));const media=await this.probeFile(file,tool);durationSeconds=positive(media.durationSeconds);}catch{}
        this.index.set(key,{signature,durationSeconds});await this.save();return durationSeconds;
      }finally{this.active--;this.waiters.shift()?.();}
    })().finally(()=>this.pending.delete(key));this.pending.set(key,task);return task;
  }
}
module.exports={parseDuration,bangumiDuration,formatDuration,DurationIndex};
