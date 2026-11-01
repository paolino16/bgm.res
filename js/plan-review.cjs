const path=require('node:path');
const key=value=>path.resolve(value).replace(/\\/g,'/').toLowerCase();
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
    if(item.row.ai&&item.row.ai.confidence!=='High'&&!item.row.manual_mapping)item.reasons.push('AI '+item.row.ai.confidence+' 置信度：'+item.row.ai.reason);
    item.attention=!item.row.skip&&item.reasons.length>0;
    item.target=item.preview?.target||'';item.targetLabel=item.preview?.target_label||'待确认目标';
    item.status=item.row.skip?'跳过':item.attention?'需核对':item.preview?.action==='同源跳过'?'同源保留':'正常';
  }
  return files.sort((a,b)=>Number(b.attention)-Number(a.attention)||Number(a.row.skip)-Number(b.row.skip)||a.index-b.index);
}
module.exports={reviewRows};
