// Canonical rename bindings -> the original bgm.res WorkSaveNo / EPDetails API.
const fs=require('fs/promises');
const path=require('path');
const crypto=require('crypto');
const video=/\.(mkv|mp4|avi|m2ts|ts|mov|webm|m4v|wmv)$/i;
const normalized=p=>path.resolve(p).replace(/\\/g,'/').toLowerCase();
const clone=x=>JSON.parse(JSON.stringify(x));
function setDeep(obj,keys,value){for(const k of keys.slice(0,-1)){if(!obj[k]||typeof obj[k]!=='object')obj[k]={};obj=obj[k];}obj[keys[keys.length-1]]=value;}
function getDeep(obj,keys){for(const k of keys){if(obj==null||!Object.prototype.hasOwnProperty.call(obj,k))return false;obj=obj[k];}return obj;}
function orderedKeys(data){const pref=data.LibrarySort||{key:'WorkSaveNo',order:'asc'};return Object.keys(data).filter(k=>/^WorkSaveNo\d+$/.test(k)).sort((a,b)=>{
  const aa=pref.key==='WorkSaveNo'?Number(a.slice(10)):data[a][pref.key],bb=pref.key==='WorkSaveNo'?Number(b.slice(10)):data[b][pref.key];
  const cmp=typeof aa==='number'&&typeof bb==='number'?aa-bb:String(aa||'').localeCompare(String(bb||''),'zh-CN',{numeric:true});return (pref.order==='desc'?-cmp:cmp)||Number(a.slice(10))-Number(b.slice(10));
});}
function projection(data){const out={};orderedKeys(data).forEach((k,i)=>out['WorkSaveNo'+(i+1)]=data[k]);for(const k of Object.keys(data))if(!/^WorkSaveNo\d+$/.test(k))out[k]=data[k];return out;}
function resolveKey(data,key){const m=key.match(/^WorkSaveNo(\d+)(.*)$/);if(!m)return key;const stable=orderedKeys(data)[Number(m[1])-1];return (stable||'WorkSaveNo'+m[1])+m[2];}
function allSlots(work,type='EP'){return Object.values(work?.[type+'Details']||{});}
function projectEpisodes(work,rows,collection=false){
  const byID=new Map(rows.map(row=>[String(collection?row.episode?.id:row.id),row]));
  const slots=collection?allSlots(work):[...allSlots(work),...allSlots(work,'SP')];
  return slots.map((slot,i)=>{
    const row=byID.get(String(slot.EpisodeID));
    if(collection)return row?clone(row):{type:0,episode:{id:slot.EpisodeID||null},binding_unresolved:!slot.EpisodeID};
    return row?{...row,original_ep:row.ep,original_sort:row.sort,ep:row.type===0?slot.LocalIndex:undefined,sort:slot.LocalIndex}:null;
  }).filter(Boolean);
}
async function readRename(dataDir){
  const names=(await fs.readdir(path.join(dataDir,'task'))).filter(n=>n.endsWith('.json')).sort(),groups=new Map(),errors=[];
  const used=new Map();
  for(const name of names){try{
    const task=JSON.parse(await fs.readFile(path.join(dataDir,'task',name),'utf8'));
    let record;try{record=JSON.parse(await fs.readFile(path.join(dataDir,'record',name),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    const bindings=new Map((record.episode_bindings||task.episode_bindings||[]).map(b=>[normalized(b.source),b]));
    for(const [source,entry] of Object.entries(record.entries||record)){
      const target=typeof entry==='string'?entry:entry?.target;if(!target||!path.isAbsolute(target)||!video.test(target))continue;
      const b=bindings.get(normalized(source))||{},bgm=String(b.subject_id||task.subject_id||task.bgm_id||'');
      if(!/^\d+$/.test(bgm)){errors.push({file:target,error:'缺少明确 Bangumi 条目 ID，未接管'});continue;}
      const identity=bgm+':'+(b.episode_id||'');const pk=normalized(target);
      if(used.has(pk)){if(used.get(pk)!==identity)throw Error('同一输出文件存在不同章节绑定：'+target);continue;}used.set(pk,identity);
      if(!groups.has(bgm))groups.set(bgm,{id:bgm,title:task.bangumi_name||task.name||path.basename(path.dirname(target)),year:task.year||'',files:[]});
      const number=path.basename(target).match(/(?:^|[\s[\]_.-])(?:EP|SP|S\d+E)(\d+(?:[._-]\d+)*)/i)?.[1];
      const type=b.category==='extra'?'extra':b.episode_type!=null?Number(b.episode_type):b.category==='special'?1:/[\\/](?:extras?)[\\/]/i.test(target)?'extra':/[\\/](?:specials?|sps?)[\\/]/i.test(target)?1:null;
      groups.get(bgm).files.push({path:target,taskId:task.uuid||name,source,episodeId:b.episode_id?String(b.episode_id):null,number:b.episode!=null?String(b.episode):number||null,type});
    }
  }catch(e){errors.push({file:name,error:e.message});}}
  // A contradictory mapping is never silently resolved by traversal order.
  if(errors.some(e=>e.error.startsWith('同一输出文件')))throw Error(errors.find(e=>e.error.startsWith('同一输出文件')).error);
  return {groups:[...groups.values()],errors};
}
function mergeWork(group,existing={},workKey){
  let root=path.dirname(group.files[0].path);
  for(const file of group.files){while(root!==path.dirname(root)&&path.relative(root,file.path).startsWith('..'))root=path.dirname(root);}
  const work={WorkSaveNo:workKey,Name:group.title,URL:root,bgmID:group.id,Year:group.year||'0000',Score:'0.0',Type:'TV',Eps:0,Protocol:'Unknown',Director:'Unknown',Corp:'Unknown',Cover:'./assets/banner.jpg',ExistCondition:'Exist',...clone(existing)};
  work.URL=root;
  const oldSlots=[...allSlots(existing),...allSlots(existing,'SP'),...[...(existing.RenameBinding?.resources||[]),...(existing.RenameBinding?.invalidResources||[]),...(existing.RenameBinding?.dismissedResources||[])].map(f=>({...f,AbsolutePath:f.path}))],byEpisode=new Map(oldSlots.filter(s=>s.EpisodeID).map(s=>[String(s.EpisodeID),s])),byPath=new Map(oldSlots.flatMap(s=>(s.Versions||[{path:s.AbsolutePath||path.resolve(existing.URL||root,s.URL||'')}]).map(v=>[normalized(v.path),s])));
  const epGroups=new Map(),spGroups=new Map(),extras=[],invalid=[];
  for(const file of group.files){if(file.availability==='removed')continue;if((file.availability&&file.availability!=='available')||file.type==='extra'||(typeof file.type==='number'&&file.type>=1)){const old=byPath.get(normalized(file.path));const destination=file.availability&&file.availability!=='available'?invalid:extras;destination.push({...file,Condition:old?.Condition||'Unwatched',...(old?.LastWatched?{LastWatched:old.LastWatched}:{})});continue;}const map=epGroups;const k=file.episodeId?'id:'+file.episodeId:'path:'+normalized(file.path);if(!map.has(k))map.set(k,[]);map.get(k).push(file);}
  function slots(map,type){const out={};let index=0;const sorted=[...map.values()].sort((a,b)=>Number(a[0].number??Infinity)-Number(b[0].number??Infinity)||a[0].path.localeCompare(b[0].path));
    for(const files of sorted){index++;const f=files[0],old=byEpisode.get(f.episodeId)||byPath.get(normalized(f.path))||{};
      const preferred=files.find(v=>normalized(v.path)===normalized(old.AbsolutePath||path.resolve(root,old.URL||'')))||files[0];
      out[type+index]={...old,URL:path.relative(root,preferred.path),AbsolutePath:preferred.path,EpisodeID:f.episodeId,EpisodeNumber:f.number,EpisodeType:type==='EP'?0:1,LocalIndex:index,Condition:old.Condition||'Unwatched',Versions:files.map(v=>({path:v.path,taskId:v.taskId,source:v.source})),BindingSource:'BangumiAutoRename'};
    }return out;
  }
  work.EPDetails=slots(epGroups,'EP');work.SPDetails=slots(spGroups,'SP');work.EPTrueNum=Object.keys(work.EPDetails).length;work.SPTrueNum=Object.keys(work.SPDetails).length;
  work.Eps=Math.max(Number(existing.Eps)||0,work.EPTrueNum);work.RenameBinding={schema:1,subjectId:group.id,dataSource:'BangumiAutoRename',resources:extras,invalidResources:invalid,dismissedResources:(existing.RenameBinding?.dismissedResources||[]).filter(row=>group.files.some(file=>normalized(file.path)===normalized(row.path)&&file.availability==='removed')),ignoredMissing:group.files.filter(file=>file.availability==='removed').map(file=>file.path),files:group.files,fingerprint:crypto.createHash('sha256').update(JSON.stringify(group.files)).digest('hex')};
  return work;
}
function remapRecent(records,previous,next){
  return (records||[]).map(record=>{
    if(record.workID!==next.WorkSaveNo)return record;
    const match=record.episode?.match(/^(EP|SP)(\d+)$/);if(!match)return record;
    const old=previous?.[match[1]+'Details']?.[record.episode];if(!old)return record;
    const oldPath=normalized(old.AbsolutePath||path.resolve(previous.URL,old.URL||''));
    const resource=[...(next.RenameBinding?.resources||[]),...(next.RenameBinding?.invalidResources||[])].find(file=>normalized(file.path)===oldPath);
    if(resource){resource.LastWatched=clone(record);return null;}
    for(const type of ['EP','SP'])for(const [key,slot]of Object.entries(next[type+'Details']||{})){
      if((old.EpisodeID&&String(old.EpisodeID)===String(slot.EpisodeID))||(slot.Versions||[]).some(v=>normalized(v.path)===normalized(old.AbsolutePath||path.resolve(previous.URL,old.URL||''))))return {...record,episode:key};
    }
    return next.RenameBinding?null:record;
  }).filter(Boolean);
}
module.exports={normalized,readRename,mergeWork,projection,resolveKey,orderedKeys,setDeep,getDeep,allSlots,projectEpisodes,remapRecent};
