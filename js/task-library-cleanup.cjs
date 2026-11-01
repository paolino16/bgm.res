// Sole-task works disappear with the task; shared works are rebuilt from remaining records.
function removedWorks(data,taskId){return Object.entries(data).filter(([key,work])=>{
  const files=work?.RenameBinding?.files||[];
  return /^WorkSaveNo\d+$/.test(key)&&files.length>0&&files.every(file=>file.taskId===taskId);
}).map(([key])=>key);}
module.exports={removedWorks};
