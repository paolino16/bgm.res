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
function specialChapters(work,episodes){
  const bindings=new Map();
  function add(id,file){if(!id||!file.path)return;const key=String(id);if(!bindings.has(key))bindings.set(key,new Map());const files=bindings.get(key),identity=normalized(file.path),old=files.get(identity);if(!old||file.availability)files.set(identity,{...old,...file});}
  for(const kind of ['EPDetails','SPDetails'])for(const slot of Object.values(work[kind]||{}))for(const version of slot.Versions||[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))}])add(slot.EpisodeID,version);
  for(const file of [...(work.RenameBinding?.resources||[]),...(work.RenameBinding?.files||[]),...(work.RenameBinding?.invalidResources||[])]){
    if(file.subjectId&&String(file.subjectId)!==String(work.bgmID))continue;
    add(file.episodeId,file);
  }
  const groups=new Map();
  for(const episode of episodes){const type=Number(episode.type);if(!Number.isInteger(type)||type===0||type<0)continue;
    const category=types[type]||{title:'其他章节（类型 '+type+'）',code:'其他'};
    if(!groups.has(type))groups.set(type,{type,...category,rows:[]});
    const files=[...(bindings.get(String(episode.id))?.values()||[])];const usable=files.filter(file=>!file.availability||file.availability==='available');
    groups.get(type).rows.push({...episode,files,usable,state:!files.length?'unmapped':!usable.length?'unavailable':'mapped'});
  }
  return [...groups.values()].sort((a,b)=>a.type-b.type).map(group=>({...group,rows:group.rows.sort((a,b)=>Number(a.sort??a.ep??0)-Number(b.sort??b.ep??0)||Number(a.id)-Number(b.id))}));
}
module.exports={loadCatalogue,specialChapters,types};
