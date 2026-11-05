const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const core=require('./rename-binding-core.cjs');
const hash=file=>crypto.createHash('sha256').update(core.normalized(file)).digest('hex');
const subtitles=/^\.(?:(?:[a-z0-9_-]+)\.)*(ass|ssa|srt|vtt|sub|idx|sup|smi|sami|ttml)$/i;
function replacePaths(value,mapping){
  if(typeof value==='string')return mapping.get(value)||value;
  if(Array.isArray(value))return value.map(v=>replacePaths(v,mapping));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[mapping.get(k)||k,replacePaths(v,mapping)]));
  return value;
}
async function exists(file){try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function atomic(file,text){const tmp=file+'.collection-'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,text);await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(()=>{});}}
async function renameCollection({work,file,episodeIds,dataDir,persist}){
  const registered=require('./file-operations.cjs').select(work,[file],false)[0];
  const task=String(registered.taskId||'').replace(/\.json$/,'');
  if(!/^[\w-]+$/.test(task))throw Error('文件缺少整理任务记录，无法同步重命名');
  const recordPath=path.join(dataDir,'record',task+'.json'),recordText=await fs.readFile(recordPath,'utf8'),record=JSON.parse(recordText);
  const entry=Object.entries(record.entries||{}).find(([,v])=>core.normalized(typeof v==='string'?v:v?.target||'')===core.normalized(file));
  if(!entry)throw Error('整理记录中的文件路径已变化，请刷新后重试');
  const taskData=JSON.parse(await fs.readFile(path.join(dataDir,'task',task+'.json'),'utf8'));
  const suffix=path.extname(file),stem=path.basename(file,suffix);
  const group=String(taskData.subtitle_group||registered.subtitleGroup||stem.match(/ \[([^\]]+)\]$/)?.[1]||'').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  const title=String(work.Name||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').trim();
  if(!title)throw Error('作品名不能为空');
  const target=path.join(path.dirname(file),title+(group?' ['+group+']':'')+suffix);
  const mapping=new Map(),moves=[],seen=new Set();
  const mirror=typeof entry[1]==='object'?entry[1].mirror:null;
  async function add(source,destination,allowMirror=false){
    if(source===destination||seen.has(core.normalized(source)))return;
    seen.add(core.normalized(source));
    const info=await fs.lstat(source);if(!info.isFile()&&!info.isSymbolicLink())throw Error('只能重命名视频及关联字幕文件');
    if(await exists(destination))throw Error('目标文件已存在：'+destination);
    let oldLink,newLink;
    if(info.isSymbolicLink()){
      oldLink=await fs.readlink(source);newLink=oldLink;
      const resolved=path.resolve(path.dirname(source),oldLink);
      if(allowMirror&&mirror&&path.dirname(resolved)===path.dirname(mirror)){
        const newReal=path.join(path.dirname(resolved),path.basename(destination));
        await add(resolved,newReal);newLink=newReal;
      }
    }
    moves.push({source,destination,oldLink,newLink});mapping.set(source,destination);
  }
  await add(file,target,true);
  const neighbors=await fs.readdir(path.dirname(file));
  const videos=neighbors.filter(n=>/\.(mkv|mp4|avi|m2ts|ts|mov|webm|m4v|wmv)$/i.test(n));
  for(const name of neighbors){if(!name.startsWith(stem+'.')||!subtitles.test(name.slice(stem.length)))continue;
    if(videos.some(v=>{const other=path.basename(v,path.extname(v));return other.length>stem.length&&name.startsWith(other+'.');}))continue;
    await add(path.join(path.dirname(file),name),path.join(path.dirname(target),path.basename(target,suffix)+name.slice(stem.length)),true);
  }
  // The canonical records and library must agree before returning success.
  const documents=[];
  for(const [kind,required]of [['record',true],['task',true],['rename_plans',false]]){
    const filename=path.join(dataDir,kind,task+'.json');if(!await exists(filename)){if(required)throw Error('缺少整理记录：'+filename);continue;}
    const before=await fs.readFile(filename,'utf8');let value=replacePaths(JSON.parse(before),mapping);
    if(kind!=='rename_plans'){
      const bindings=value.episode_bindings||[];let binding=bindings.find(b=>core.normalized(b.source||'')===core.normalized(entry[0]));
      if(!binding){binding={source:entry[0]};bindings.push(binding);}
      Object.assign(binding,{subject_id:String(work.bgmID),episode_id:null,episode_ids:episodeIds.map(Number),episode:null,episode_type:0,category:'collection'});value.episode_bindings=bindings;
    }
    function updateDecisions(node){if(!node||typeof node!=='object')return;if(node.source===entry[0]&&('category' in node||'episode_id' in node)){Object.assign(node,{episode_id:null,episode_ids:episodeIds.map(Number),category:'collection',episode:null,episode_type:0});if('filename' in node)node.filename='';}for(const child of Object.values(node))updateDecisions(child);}
    updateDecisions(value);
    documents.push({filename,before,after:JSON.stringify(value,null,2)});
  }
  const previous=replacePaths(work,mapping);
  previous.CollectionBindings={...previous.CollectionBindings};delete previous.CollectionBindings[hash(file)];previous.CollectionBindings[hash(target)]={episodeIds:episodeIds.map(String)};
  for(const row of previous.RenameBinding.files)if(core.normalized(row.path)===core.normalized(target))Object.assign(row,{collection:true,episodeIds:episodeIds.map(String),episodeId:null,type:0});
  const groupData={id:String(work.bgmID),title:work.Name,files:previous.RenameBinding.files};
  const next=core.mergeWork(groupData,previous,work.WorkSaveNo);
  const completed=[],written=[];
  try{
    for(const move of moves){
      if(move.oldLink!==undefined)await fs.symlink(move.newLink,move.destination,'file');else await fs.link(move.source,move.destination);
      try{await fs.unlink(move.source);}catch(e){await fs.unlink(move.destination).catch(()=>{});throw e;}
      completed.push(move);
    }
    for(const doc of documents){if(await fs.readFile(doc.filename,'utf8')!==doc.before)throw Error('整理记录发生变化，请刷新后重试');await atomic(doc.filename,doc.after);written.push(doc);}
    await persist(next,previous,mapping);
  }catch(error){
    const failures=[];
    for(const doc of written.reverse())try{await atomic(doc.filename,doc.before);}catch(e){failures.push(e.message);}
    for(const move of completed.reverse())try{
      if(move.oldLink!==undefined)await fs.symlink(move.oldLink,move.source,'file');else await fs.link(move.destination,move.source);
      await fs.unlink(move.destination);
    }catch(e){failures.push(e.message);}
    if(failures.length)throw Error(error.message+'；回退未完成：'+failures.join('；'));
    if(error.code==='EBUSY')throw Error('文件正被其他程序占用，改名已回退。请关闭占用程序后重试：'+(error.path||file));
    throw error;
  }
  return next;
}
module.exports={renameCollection,replacePaths};
