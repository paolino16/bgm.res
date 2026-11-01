const fs=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process');
const {normalized}=require('./rename-binding-core.cjs');
const extensions=new Set(['.ass','.ssa','.srt','.vtt','.sub','.idx','.sup','.smi','.sami','.ttml']);
function run(file,args,timeout=15000){return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout,maxBuffer:2*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout)));}
async function findProbe(){
  if(process.env.BGM_FFPROBE)return {file:process.env.BGM_FFPROBE,kind:'ffprobe'};
  for(const file of [path.resolve(__dirname,'../mpv/ffprobe.exe')])try{await fs.access(file);return {file,kind:'ffprobe'};}catch{}
  try{const found=await run('where.exe',['ffprobe.exe'],3000);if(found.trim())return {file:found.trim().split(/\r?\n/)[0],kind:'ffprobe'};}catch{}
  const file=path.resolve(__dirname,'../mpv/ffmpeg.exe');await fs.access(file);return {file,kind:'ffmpeg'};
}
async function probeMedia(file,tool){
  if(tool.kind==='ffprobe'){
    const json=JSON.parse(await run(tool.file,['-v','error','-show_entries','format=duration:stream=index,codec_type,codec_name,duration:stream_tags=language,title','-of','json','-i',file]));
    if(!Array.isArray(json.streams)||!json.streams.some(s=>s.codec_type==='video'))throw Error('未识别到视频轨');
    return {durationSeconds:Number(json.format?.duration)>0?Number(json.format.duration):Math.max(0,...json.streams.map(s=>Number(s.duration)||0))||null,internal:json.streams.filter(s=>s.codec_type==='subtitle').map(s=>({codec:s.codec_name||'',language:s.tags?.language||'',title:s.tags?.title||''}))};
  }
  let text='';try{await run(tool.file,['-hide_banner','-nostdin','-i',file]);}catch(error){text=error.stderr||'';}
  if(!/Input #0,/.test(text)||!/Stream #0:\d+.*Video:/.test(text))throw Error('无法读取视频轨道信息');
  return {durationSeconds:require('./media-duration.cjs').parseDuration(text.match(/Duration:\s*([\d:.]+)/)?.[1]||''),internal:text.split(/\r?\n/).filter(line=>/Stream #0:\d+.*Subtitle:/.test(line)).map(line=>({codec:line.match(/Subtitle:\s*([^ ,]+)/)?.[1]||'',language:line.match(/Stream #0:\d+(?:\[[^\]]+\])?\(([^)]+)\)/)?.[1]||'',title:''}))};
}
async function probe(file,tool){return (await probeMedia(file,tool)).internal;}
function filesOf(work){const files=new Map();for(const slot of Object.values(work.EPDetails||{}))for(const version of slot.Versions||[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))}])if(version.path)files.set(normalized(version.path),version.path);return [...files.values()];}
function describe(info){if(!info)return '未检测';if(info.state==='unavailable')return '文件离线 / 无法访问';const labels=[];if(info.external?.length)labels.push('外挂 '+info.external.length);if(info.internal?.length)labels.push('内封 '+info.internal.length);if(info.manual==='burned')labels.push('画面内嵌（手动确认）');if(labels.length)return labels.join(' · ');if(info.state==='unavailable')return '文件离线 / 无法访问';if(info.state==='error')return '轨道检测失败';if(info.manual==='none')return '已确认无字幕';return '未检测到字幕 · 画面内嵌待确认';}
function positive(info){return Boolean(info&&info.state!=='unavailable'&&(info.external?.length||info.internal?.length||info.manual==='burned'));}
function summary(work,index){
  const chapters=Object.values(work.EPDetails||{});let covered=0,uncertain=0,missing=0,unknown=0;
  for(const slot of chapters){const versions=slot.Versions||[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))}];const rows=versions.map(v=>index.get(normalized(v.path||'')));
    if(rows.some(positive))covered++;
    else if(rows.length&&rows.every(r=>r?.manual==='none'&&r.state!=='unavailable'))missing++;
    else if(rows.some(r=>!r||r.state!=='checked'))unknown++;
    else uncertain++;
  }
  const total=chapters.length;return {total,covered,missing,uncertain,unknown,status:total&&covered===total?'complete':covered?'partial':missing===total&&total?'missing':uncertain||missing?'unconfirmed':'unknown'};
}
function summaryLabel(s){if(!s?.total)return '暂无可检测章节';if(s.covered===s.total)return '全剧有字幕 · '+s.covered+'/'+s.total+' 集';if(s.covered)return '部分集有字幕 · '+s.covered+'/'+s.total+' 集';if(s.missing===s.total)return '已确认无字幕';if(s.unknown===s.total)return '字幕未检测 / 未知';return '未检测到字幕 · 待确认';}
class SubtitleIndex{
  constructor({directory,probeFile=probeMedia,resolveTool=findProbe,onProgress=()=>{}}){this.filename=path.join(directory,'subtitle-index.json');this.index=new Map();this.probeFile=probeFile;this.resolveTool=resolveTool;this.onProgress=onProgress;this.pending=new Map();this.saveQueue=Promise.resolve();this.active=0;this.waiters=[];this.progress={running:false,done:0,total:0};}
  async load(){try{const stored=JSON.parse(await fs.readFile(this.filename,'utf8'));if(stored.version===1)this.index=new Map(Object.entries(stored.files||{}));}catch{}}
  save(){const value=JSON.stringify({version:1,files:Object.fromEntries(this.index)},null,2);const next=this.saveQueue.then(async()=>{const tmp=this.filename+'.tmp';await fs.writeFile(tmp,value);await fs.rename(tmp,this.filename);});this.saveQueue=next.catch(()=>{});return next;}
  async limited(fn){if(this.active>=2)await new Promise(r=>this.waiters.push(r));this.active++;try{return await fn();}finally{this.active--;this.waiters.shift()?.();}}
  async inspect(file,force=false){
    const key=normalized(file);if(this.pending.has(key))return this.pending.get(key);
    const pending=this.limited(async()=>{
      const previous=this.index.get(key);let stat;
      try{stat=await fs.stat(file);if(!stat.isFile()||!stat.size)throw Error('不是有效视频文件');}catch(error){const result={...previous,path:file,state:'unavailable',error:error.message};this.index.set(key,result);return result;}
      const signature=[stat.dev,stat.ino,stat.size,stat.mtimeMs].join(':');const unchanged=previous?.signature===signature;
      const base=path.basename(file,path.extname(file)).toLocaleLowerCase();const external=[];let externalError;
      // Use the longest video basename; Show.01.ass must not match Show.mkv.
      for(const folder of [path.dirname(file),path.join(path.dirname(file),'Subs'),path.join(path.dirname(file),'Subtitles')]){
        try{const entries=await fs.readdir(folder,{withFileTypes:true});const videos=folder===path.dirname(file)?entries.filter(e=>(e.isFile()||e.isSymbolicLink())&&/\.(mkv|mp4|avi|m2ts|ts|mov|wmv|webm|flv|mpg|mpeg|m4v)$/i.test(e.name)).map(e=>path.basename(e.name,path.extname(e.name)).toLocaleLowerCase()):[];
          for(const entry of entries){if((!entry.isFile()&&!entry.isSymbolicLink())||!extensions.has(path.extname(entry.name).toLowerCase()))continue;const stem=path.basename(entry.name,path.extname(entry.name)).toLocaleLowerCase();if(stem!==base&&!stem.startsWith(base+'.'))continue;if(videos.some(v=>v.length>base.length&&(stem===v||stem.startsWith(v+'.'))))continue;const target=path.join(folder,entry.name);if((await fs.stat(target)).size>0)external.push(target);}
        }catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))externalError=error.message;}
      }
      let internal=unchanged?previous.internal:undefined,durationSeconds=unchanged?previous.durationSeconds:undefined,error,state='checked';
      if(!internal||force||previous?.state==='error'){
        try{const tool=await (this.toolPromise||(this.toolPromise=this.resolveTool()));const media=await this.probeFile(file,tool);internal=Array.isArray(media)?media:media.internal;durationSeconds=Array.isArray(media)?undefined:media.durationSeconds;}catch(exc){error=exc.message;state='error';}
      }
      if(externalError){state='error';error=externalError;}
      const result={path:file,signature,external,internal:internal||[],durationSeconds,state,error,manual:unchanged?previous.manual:undefined,checked_at:new Date().toISOString()};this.index.set(key,result);return result;
    }).finally(()=>this.pending.delete(key));this.pending.set(key,pending);return pending;
  }
  async scan(work,force=false){await Promise.all(filesOf(work).map(file=>this.inspect(file,force)));await this.save();return this.details(work);}
  details(work){return {summary:summary(work,this.index),files:filesOf(work).map(file=>({path:file,...this.index.get(normalized(file)),label:describe(this.index.get(normalized(file)))})),progress:this.progress};}
  decorate(data){for(const work of Object.values(data))if(work?.WorkSaveNo)work.SubtitleSummary=summary(work,this.index);return data;}
  async mark(file,value){if(!['burned','none',''].includes(value))throw Error('字幕确认类型无效');await this.inspect(file);const row=this.index.get(normalized(file));if(!row?.signature||row.state==='unavailable')throw Error('文件不可用，不能确认');if(value==='none'&&(row.external?.length||row.internal?.length))throw Error('已检测到字幕轨或外挂文件，不能标记无字幕；请核对字幕语言。');row.manual=value||undefined;await this.save();return row;}
  startAll(data){if(this.progress.running)return this.progress;const works=Object.values(data).filter(w=>w?.ExistCondition==='Exist');const files=[...new Set(works.flatMap(filesOf))];this.progress={running:true,done:0,total:files.length};
    (async()=>{try{let next=0;const worker=async()=>{while(next<files.length){const file=files[next++];await this.inspect(file);this.progress.done++;if(this.progress.done%25===0){await this.save();this.onProgress(this.progress);}}};await Promise.all([worker(),worker()]);await this.save();}catch(error){this.progress.error=error.message;}finally{this.progress.running=false;this.onProgress(this.progress);}})();return this.progress;}
}
module.exports={SubtitleIndex,filesOf,describe,positive,summary,summaryLabel,probe,probeMedia,findProbe};
