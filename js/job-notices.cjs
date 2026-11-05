'use strict';
const STORAGE_KEY='organizer-dismissed-job-notices';
function loadDismissed(storage){try{const ids=JSON.parse(storage?.getItem(STORAGE_KEY)||'[]');return new Set(Array.isArray(ids)?ids.filter(id=>typeof id==='string').slice(-200):[]);}catch{return new Set();}}
function saveDismissed(storage,ids){try{storage?.setItem(STORAGE_KEY,JSON.stringify([...ids].slice(-200)));}catch{}}
function visibleFailures(jobs,{dismissed=new Set(),historical=new Set(),taskId}={}){
  const latest=new Map(),recovered=new Map();let sequence=0;
  const recoveryActions=new Set(['deepseek-plan','retry','recognize','execute','cancel-review','check','save-task','add-subject']);
  for(const job of jobs){const index=sequence++,group=JSON.stringify([job.action,job.task_id||job.id]);latest.set(group,{job,index});if(job.task_id&&job.state==='completed'&&recoveryActions.has(job.action))recovered.set(job.task_id,index);}
  return [...latest.values()].filter(({job,index})=>job.state==='failed'&&!dismissed.has(job.id)&&!historical.has(job.id)&&(!taskId||job.task_id===taskId)&&!(job.task_id&&recovered.get(job.task_id)>index)).slice(-3).map(({job})=>job);
}
module.exports={visibleFailures,loadDismissed,saveDismissed};
