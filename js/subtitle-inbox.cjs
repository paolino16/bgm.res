'use strict';
const fs=require('node:fs'),path=require('node:path');
const extensions=new Set(['.ass','.ssa','.srt','.vtt','.sub','.idx','.sup','.smi','.sami','.ttml']);
function create(directory){
  const root=path.resolve(directory),manifest=path.join(root,'.inbox.json');
  let items=[];
  if(fs.existsSync(manifest))items=JSON.parse(fs.readFileSync(manifest,'utf8')).items||[];
  function save(){fs.mkdirSync(root,{recursive:true});const tmp=manifest+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,items},null,2));fs.renameSync(tmp,manifest);}
  function checked(folder){
    const resolved=path.resolve(folder);
    if(path.dirname(resolved)!==root||!/^[a-f0-9]{32}$/.test(path.basename(resolved)))throw Error('无效下载包目录');
    if(fs.existsSync(resolved)&&(fs.lstatSync(resolved).isSymbolicLink()||path.dirname(fs.realpathSync(resolved))!==fs.realpathSync(root)))throw Error('下载包目录已变化，未清理');
    return resolved;
  }
  function filesIn(folder){const result=[];for(const item of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isSymbolicLink())continue;if(item.isDirectory())result.push(...filesIn(file));else if(item.isFile()&&extensions.has(path.extname(item.name).toLowerCase()))result.push(file);}return result;}
  // Adopt pre-existing packages without deleting or guessing their import state.
  if(fs.existsSync(root))for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^[a-f0-9]{32}$/.test(entry.name)||items.some(item=>item.id===entry.name))continue;
    const folder=checked(path.join(root,entry.name));items.push({id:entry.name,folder,name:fs.readdirSync(folder).find(name=>name!=='files')||'历史下载包',created:fs.statSync(folder).birthtimeMs,files:filesIn(folder).map(file=>({path:file,state:'pending'})),state:'pending'});
  }
  function record(value,metadata={}){
    const folder=checked(value.folder),id=path.basename(folder);
    const item={id,folder,name:path.basename(value.archive||folder),created:Date.now(),source:metadata.source,
      workId:metadata.workId||null,workName:metadata.workName||'',files:(value.files||[]).map(file=>({path:file,state:'pending'})),state:'pending',warning:value.warning||''};
    items.push(item);save();return item;
  }
  function list(){return items.map(item=>({...item,remaining:item.files.filter(file=>file.state==='pending').map(file=>file.path),done:item.files.filter(file=>file.state==='imported').length})).sort((a,b)=>b.created-a.created);}
  function clean(item){
    try{const folder=checked(item.folder);fs.rmSync(folder,{recursive:true,force:true});item.state='cleaned';item.error='';}
    catch(error){item.state='cleanup-failed';item.error=error.message;}
    save();return item;
  }
  function imported(sources){
    const matched=new Set(sources.map(file=>path.resolve(file).toLowerCase()));
    for(const item of items.filter(item=>item.state!=='cleaned')){
      let changed=false;for(const file of item.files)if(matched.has(path.resolve(file.path).toLowerCase())){file.state='imported';changed=true;}
      if(changed){save();if(item.files.length&&item.files.every(file=>file.state!=='pending'))clean(item);}
    }
  }
  function command({id,command,workId,workName}){
    const item=items.find(item=>item.id===id);if(!item)throw Error('下载包不存在');
    if(command==='assign'){item.workId=workId;item.workName=workName;save();return item;}
    if(command==='discard'){for(const file of item.files)if(file.state==='pending')file.state='discarded';save();return clean(item);}
    if(command==='clean'&&item.files.every(file=>file.state!=='pending'))return clean(item);
    throw Error('仍有未处理字幕，请继续导入或明确放弃剩余文件');
  }
  function folder(value){const item=items.find(item=>path.resolve(item.folder)===path.resolve(value));if(!item||item.state==='cleaned')throw Error('下载包已清理或不存在');return checked(item.folder);}
  function reconcile(operationDirectory){
    const candidates=new Set(items.filter(item=>item.state!=='cleaned').flatMap(item=>item.files.filter(file=>file.state==='pending').map(file=>path.resolve(file.path).toLowerCase())));
    if(!candidates.size||!fs.existsSync(operationDirectory))return;
    const completed=[],hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    for(const entry of fs.readdirSync(operationDirectory,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^[a-f0-9]{32}$/.test(entry.name))continue;
      const journal=path.join(operationDirectory,entry.name,'journal.json');if(!fs.existsSync(journal))continue;
      const receipt=JSON.parse(fs.readFileSync(journal,'utf8'));if(!['completed','committed'].includes(receipt.state))continue;
      for(const item of receipt.imports||[]){
        if(!candidates.has(path.resolve(item.source).toLowerCase()))continue;
        try{if(hash(item.source)===item.hash&&hash(item.target)===item.hash)completed.push(item.source);}catch{/* Missing files remain pending. */}
      }
    }
    if(completed.length)imported(completed);
  }
  return {record,list,imported,command,folder,reconcile};
}
let active;
module.exports={create,setActive:client=>{active=client;},recordImported:sources=>active?.imported(sources)};
