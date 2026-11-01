const core=require('./rename-binding-core.cjs');
function select(work,paths,invalidOnly=true){
  const rows=invalidOnly?work?.RenameBinding?.invalidResources:work?.RenameBinding?.files;
  if(!Array.isArray(rows)||!Array.isArray(paths)||!paths.length)throw Error('没有可处理的文件记录');
  const selected=[...new Set(paths.map(core.normalized))].map(key=>rows.find(row=>core.normalized(row.path)===key));
  if(selected.some(row=>!row))throw Error('只能处理当前番剧已登记的文件');
  return selected;
}
function dismiss(work,paths,invalidOnly=true){
  const selected=select(work,paths,invalidOnly),next=JSON.parse(JSON.stringify(work));
  const ignored=new Map((next.RenameBinding.dismissedResources||[]).map(row=>[core.normalized(row.path),row]));
  const slots=[...core.allSlots(work),...core.allSlots(work,'SP')];
  for(const row of selected){
    const slot=slots.find(slot=>(slot.Versions||[{path:slot.AbsolutePath}]).some(version=>version.path&&core.normalized(version.path)===core.normalized(row.path)));
    ignored.set(core.normalized(row.path),{...row,Condition:slot?.Condition||row.Condition||'Unwatched'});
  }
  const keys=new Set(selected.map(row=>core.normalized(row.path)));
  next.RenameBinding.dismissedResources=[...ignored.values()];
  next.RenameBinding.invalidResources=(next.RenameBinding.invalidResources||[]).filter(row=>!keys.has(core.normalized(row.path)));
  return next;
}
module.exports={select,dismiss};
