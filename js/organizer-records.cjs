'use strict';

function recordScope(work){
  const binding=work.RenameBinding||{};
  const files=[...(binding.files||[]),...(binding.resources||[]),...(binding.invalidResources||[])];
  const taskIds=[...new Set(files.flatMap(file=>[file.taskId,...(Array.isArray(file.parentTaskIds)?file.parentTaskIds:[])])
    .filter(Boolean).map(String))];
  const id=String(work.bgmID||'').trim();
  return {subjectId:/^[1-9]\d*$/.test(id)?id:'',name:String(work.Name||'').trim(),taskIds};
}
function relatedTask(task,scope){
  if(scope.taskIds.includes(String(task.uuid)))return true;
  if(scope.subjectId){
    const ids=[task.subject_id,task.bgm_id,...(Array.isArray(task.subject_ids)?task.subject_ids:[])];
    return ids.some(id=>id!=null&&String(id)===scope.subjectId);
  }
  const name=scope.name.toLocaleLowerCase();
  return Boolean(name)&&[task.name,task.path].some(value=>String(value||'').toLocaleLowerCase().includes(name));
}
module.exports={recordScope,relatedTask};
