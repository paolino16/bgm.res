const path=require('node:path');
const key=value=>path.resolve(value).replace(/\\/g,'/').toLowerCase();
function mappingKey(plan,row){
  const sid=String(row.subject_id||(plan.context?.requires_subject_assignment?'':plan.context?.subject_id)||'');
  return JSON.stringify([sid,String(row.episode_id||''),[...(row.episode_ids||[])].map(String).sort(),row.category||'',row.filename||'',row.version||'',row.season??null,row.episode??null,Boolean(row.skip)]);
}
function isMappingConfirmed(plan,row){return Boolean(row.mapping_confirmation&&row.mapping_confirmation===mappingKey(plan,row));}
function canConfirmMapping(plan,row){
  if(plan.context?.layout!=='bangumi'||row.skip)return false;
  const sid=String(row.subject_id||(plan.context.requires_subject_assignment?'':plan.context.subject_id)||'');
  const subjects={[String(plan.context.subject_id)]:plan.context,...plan.context.subjects},subject=subjects[sid];
  if(!subject)return false;
  if(row.category==='extra')return true;
  const catalog=subject.episodes||[];
  if(row.category==='episode')return row.episode_id!=null&&row.episode_id!==''&&catalog.some(ep=>String(ep.id)===String(row.episode_id));
  if(row.category==='collection'){const ids=(row.episode_ids||[]).map(String);return ids.length>=2&&new Set(ids).size===ids.length&&ids.every(id=>catalog.some(ep=>String(ep.id)===id&&Number(ep.type)===0));}
  return false;
}
function confirmMappings(plan,rows,sources){
  const selected=new Set(sources);let count=0;
  const updated=rows.map(row=>{if(!selected.has(row.source)||!canConfirmMapping(plan,row)||isMappingConfirmed(plan,row))return row;count++;return {...row,manual_mapping:true,mapping_confirmation:mappingKey(plan,row)};});
  return {rows:updated,count};
}
function describeMapping(plan,row){
  if(row.skip)return '跳过 · 保持文件原样';
  if(plan.context?.layout!=='bangumi')return '季 '+(row.season??'未定')+' / 集 '+(row.episode??'未定');
  const sid=String(row.subject_id||(plan.context.requires_subject_assignment?'':plan.context.subject_id)||'');const subject=plan.context.subjects?.[sid]||(sid===String(plan.context.subject_id)?plan.context:null);
  const name=subject?.name||'未选择归属作品';
  if(row.category==='extra')return name+' · 附加资源';
  if(row.category==='collection')return name+' · 合集 '+(row.episode_ids?.length||0)+' 章';
  const ep=subject?.episodes?.find(ep=>String(ep.id)===String(row.episode_id));
  if(!ep)return name+' · 尚未选择章节';
  const type={0:'本篇',1:'特别篇',2:'OP',3:'ED',4:'预告',5:'MAD',6:'其他'}[ep.type]||'章节';
  return name+' · '+type+' '+ep.sort+(ep.name_cn||ep.name?' · '+(ep.name_cn||ep.name):'');
}
function reviewRows(plan,rows,review){
  const preview=new Map((review?.preview||[]).map(item=>[key(item.source),item]));
  const files=rows.map((row,index)=>({row,index,key:key(row.source),reasons:[]}));
  for(const issue of review?.issues||plan.issues||[]){
    let related=files.filter(item=>(issue.sources||[]).some(source=>key(source)===item.key));
    if(!related.length)for(const source of issue.sources||[]){const candidate=key(source),matches=files.filter(item=>candidate.startsWith(key(path.join(path.dirname(item.row.source),path.parse(item.row.source).name))+'.')).sort((a,b)=>b.key.length-a.key.length);if(matches.length)related.push(matches[0]);}
    if(!related.length&&issue.target)related=files.filter(item=>preview.get(item.key)?.target&&key(preview.get(item.key).target)===key(issue.target));
    if(!related.length)related=files.filter(item=>!item.row.skip);
    for(const item of related)if(!item.reasons.includes(issue.reason))item.reasons.push(issue.reason);
  }
  for(const item of files){
    item.preview=preview.get(item.key);
    if(!item.row.skip&&!item.preview?.target&&!item.reasons.length)item.reasons.push('尚未生成目标映射');
    item.validationReasons=[...item.reasons];
    item.confirmed=isMappingConfirmed(plan,item.row);
    item.canConfirm=canConfirmMapping(plan,item.row)&&!item.confirmed;
    if(item.row.mapping_confirmation&&!item.confirmed&&!item.row.skip)item.reasons.push('映射已变化，请重新确认');
    if(item.row.ai&&item.row.ai.confidence!=='High'&&!item.row.manual_mapping)item.reasons.push('AI '+item.row.ai.confidence+' 置信度：'+item.row.ai.reason);
    item.attention=!item.row.skip&&item.reasons.length>0;
    item.target=item.preview?.target||'';item.targetLabel=item.preview?.target_label||'待确认目标';
    item.status=item.row.skip?'跳过':item.attention?'需核对':item.preview?.action==='同源跳过'?'同源保留':item.confirmed?'已确认':'正常';
  }
  return files.sort((a,b)=>Number(b.attention)-Number(a.attention)||Number(a.row.skip)-Number(b.row.skip)||a.index-b.index);
}
function batchRows(rows,sources,action){
  if(!['extra','skip'].includes(action))throw Error('不支持的批量操作');
  const selected=new Set(sources);
  return rows.map(row=>!selected.has(row.source)?row:action==='skip'?{...row,skip:true}:{...row,category:'extra',episode_id:null,episode_ids:[],skip:false,manual_mapping:true});
}
module.exports={reviewRows,batchRows,canConfirmMapping,confirmMappings,isMappingConfirmed,describeMapping};
