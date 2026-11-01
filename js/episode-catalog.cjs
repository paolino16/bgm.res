const path=require('node:path');
const {normalized}=require('./rename-binding-core.cjs');
const types={1:{title:'特别篇 / OVA',code:'SP'},2:{title:'片头曲',code:'OP'},3:{title:'片尾曲',code:'ED'},4:{title:'预告 / 宣传',code:'PV'},5:{title:'MAD',code:'MAD'},6:{title:'其他章节',code:'其他'}};
async function loadCatalogue(fetchPage){
  const rows=[],ids=new Set();let offset=0,total;
  for(let pages=0;pages<1000;pages++){
    const page=await fetchPage(offset);
    if(!page||!Array.isArray(page.data)||!Number.isInteger(Number(page.total))||Number(page.total)<0)throw Error('章节目录响应不完整');
    if(total===undefined)total=Number(page.total);else if(total!==Number(page.total))throw Error('章节目录发生变化，请刷新后重试');
    if(!page.data.length&&offset<total)throw Error('未取得完整章节目录，请稍后重试');
    for(const episode of page.data){const id=String(episode.id);if(!/^[1-9]\d*$/.test(id)||ids.has(id))throw Error('章节目录包含重复或无效编号，请刷新后重试');ids.add(id);rows.push(episode);}
    offset+=page.data.length;if(offset>=total)return rows;
  }
  throw Error('章节目录超过加载上限，未使用不完整结果');
}
function episodeBindings(work){
  const bindings=new Map();
  function add(id,file){if(!id||!file.path)return;const key=String(id);if(!bindings.has(key))bindings.set(key,new Map());const files=bindings.get(key),identity=normalized(file.path),old=files.get(identity);if(!old||file.availability)files.set(identity,{...old,...file});}
  for(const kind of ['EPDetails','SPDetails'])for(const slot of Object.values(work[kind]||{}))for(const version of slot.Versions||[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))}])add(slot.EpisodeID,version);
  for(const file of [...(work.RenameBinding?.resources||[]),...(work.RenameBinding?.files||[]),...(work.RenameBinding?.invalidResources||[])]){
    if(file.subjectId&&String(file.subjectId)!==String(work.bgmID))continue;
    if(file.availability!=='removed')add(file.episodeId,file);
  }
  return bindings;
}
function regularChapters(work,episodes,today){
  if(!today){const now=new Date();today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');}
  const bindings=episodeBindings(work),slots=Object.entries(work.EPDetails||{}),used=new Set();
  const regular=episodes.filter(ep=>Number(ep.type)===0);
  const rows=regular.map(episode=>{
    const exact=slots.filter(([,slot])=>slot.EpisodeID&&String(slot.EpisodeID)===String(episode.id));
    const numbered=slots.filter(([,slot])=>!slot.EpisodeID&&slot.EpisodeNumber!=null&&String(slot.EpisodeNumber).trim()!==''&&Number(slot.EpisodeNumber)===Number(episode.sort));
    // A local sequential index is not an episode number when episodes are missing.
    const matches=exact.length?exact:numbered.length===1&&regular.filter(ep=>Number(ep.sort)===Number(episode.sort)).length===1?numbered:[];
    const files=new Map(bindings.get(String(episode.id))||[]);
    for(const [key,slot]of matches){used.add(key);for(const file of slot.Versions||[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))}])if(file.path&&!files.has(normalized(file.path)))files.set(normalized(file.path),file);}
    const all=[...files.values()],usable=all.filter(file=>!file.availability||file.availability==='available');
    const future=/^\d{4}-\d{2}-\d{2}$/.test(episode.airdate||'')&&episode.airdate>today;
    return {...episode,slotKeys:matches.map(([key])=>key),files:all,usable,state:all.length?(usable.length?'mapped':'unavailable'):future?'upcoming':'unmapped'};
  }).sort((a,b)=>Number(a.sort??a.ep??0)-Number(b.sort??b.ep??0)||Number(a.id)-Number(b.id));
  return {rows,unmatchedSlots:slots.filter(([key])=>!used.has(key)),
    missing:rows.filter(row=>row.state==='unmapped'),unavailable:rows.filter(row=>row.state==='unavailable'),upcoming:rows.filter(row=>row.state==='upcoming')};
}
function specialChapters(work,episodes){
  const bindings=episodeBindings(work);
  const groups=new Map();
  for(const episode of episodes){const type=Number(episode.type);if(!Number.isInteger(type)||type===0||type<0)continue;
    const category=types[type]||{title:'其他章节（类型 '+type+'）',code:'其他'};
    if(!groups.has(type))groups.set(type,{type,...category,rows:[]});
    const files=[...(bindings.get(String(episode.id))?.values()||[])];const usable=files.filter(file=>!file.availability||file.availability==='available');
    groups.get(type).rows.push({...episode,files,usable,state:!files.length?'unmapped':!usable.length?'unavailable':'mapped'});
  }
  return [...groups.values()].sort((a,b)=>a.type-b.type).map(group=>({...group,rows:group.rows.sort((a,b)=>Number(a.sort??a.ep??0)-Number(b.sort??b.ep??0)||Number(a.id)-Number(b.id))}));
}
module.exports={loadCatalogue,specialChapters,regularChapters,types};
