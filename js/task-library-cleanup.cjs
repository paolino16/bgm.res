// Sole-task works disappear with the task; shared works are rebuilt from remaining records.
const taskKey=value=>String(value||'').replace(/\.json$/,'');
function removedWorks(data,taskId){return Object.entries(data).filter(([key,work])=>{
  const files=work?.RenameBinding?.files||[];
  return /^WorkSaveNo\d+$/.test(key)&&files.length>0&&files.every(file=>taskKey(file.taskId)===taskKey(taskId));
}).map(([key])=>key);}
function needsTaskRefresh(group,previous,taskId){
  if(!taskId)return true;
  return [...(group.files||[]),...(previous?.RenameBinding?.files||[])].some(file=>[file.taskId,...(file.parentTaskIds||[])].some(id=>taskKey(id)===taskKey(taskId)));
}
module.exports={removedWorks,needsTaskRefresh};
