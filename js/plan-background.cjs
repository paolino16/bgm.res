'use strict';
// Lock only plan mutations; navigation, disclosure, filtering and paging stay usable.
const priorDisabled=new WeakMap();
const mutations='.plan-select-row,[data-plan-mutation]:is(button,input,select,textarea),[data-plan-mutation] button,[data-plan-mutation] input,[data-plan-mutation] select,.plan-row-editor button,.plan-row-editor input,.plan-row-editor select,.plan-row-editor textarea';
function setPlanLocked(host,locked){
  for(const control of host.querySelectorAll(mutations)){
    if(locked){if(!priorDisabled.has(control))priorDisabled.set(control,control.disabled);control.disabled=true;}
    else if(priorDisabled.has(control)){control.disabled=priorDisabled.get(control);priorDisabled.delete(control);}
  }
}
async function runPlanAI({pending,task,request,isCurrent,apply,notify,sync}){
  if(pending.has(task.uuid))throw Error('本方案已在后台识别，请勿重复提交');
  pending.set(task.uuid,true);sync();notify('AI 已在后台识别，可以返回浏览其他页面。');
  try{
    const result=await request();
    if(isCurrent()){apply(result);notify('AI 方案已生成，请核对后执行');}
    else notify('AI 识别已完成：'+task.name+'。重新打开该任务即可查看结果。');
    return result;
  }finally{pending.delete(task.uuid);sync();}
}
module.exports={setPlanLocked,runPlanAI};
