'use strict';
// Native desktop views; the Python process supplies data and executes reviewed plans only.
function create({ipc,node,button,notice,setHeader,container,isActive}){
  const state={tasks:[],jobs:new Map(),query:'',filter:'all',page:0,screen:'tasks',selected:null,plan:null,rows:[],checked:null,dirty:true,busy:0,loaded:false};
  const {reviewRows,batchRows,confirmMappings,isMappingConfirmed,describeMapping}=require('./plan-review.cjs');
  const pageSize=30;
  const {reconcileChildren,preserveInteraction}=require('./ui-regions.cjs');
  let mounted,refreshTaskList,refreshPlan;
  const watching=new Set();
  const aiRuns=new Map();
  const confirmations=new Set();
  const planIsLocked=id=>aiRuns.has(id)||confirmations.has(id);
  const {setPlanLocked,runPlanAI}=require('./plan-background.cjs');
  const {visibleFailures,loadDismissed,saveDismissed}=require('./job-notices.cjs');
  const noticeStorage=typeof localStorage==='undefined'?undefined:localStorage;
  const dismissedJobs=loadDismissed(noticeStorage),historicalFailures=new Set();
  const disclosures=new Map();
  function fold(title,key,opened=false){const box=el('details','organizer-disclosure');box.open=disclosures.has(key)?disclosures.get(key):opened;box.appendChild(el('summary','',title));box.ontoggle=()=>{if(box.isConnected)disclosures.set(key,box.open);};return box;}
  function el(tag,cls,text){return node(tag,cls,text);}
  function status(task){if(task.review_state==='cancelled')return '已取消';return task.plan_state==='pending'?'待审核':task.error?'需处理':'已完成';}
  function label(text,control){const field=el('label','organizer-field');field.append(el('span','',text),control);return field;}
  function input(value,type='text'){const item=el('input');item.type=type;item.value=value??'';return item;}
  function select(options,value){const item=el('select');for(const [id,title]of options)item.add(new Option(title,id));item.value=value??'';return item;}
  function hint(text){return el('p','inline-note',text);}
  function controls(){const bar=el('div','organizer-actions');return bar;}
  function back(){state.screen='tasks';render();}
  function invalid(){state.dirty=true;const exec=container().querySelector('[data-execute]');if(exec)exec.disabled=true;const feedback=container().querySelector('[data-review-feedback]');if(feedback)feedback.textContent='调整已变化，请重新检查后执行。';}
  async function action(action,body){
    if(aiRuns.has(body?.id)&&!['deepseek-plan','plan','deepseek-history'].includes(action))throw Error('本方案正在进行 AI 识别，请等待完成后再修改或执行；可以返回浏览其他页面。');
    const submitted=await ipc.invoke('organizer:action',{action,body});
    state.jobs.set(submitted.job_id,{id:submitted.job_id,action,state:'queued',task_id:body?.id,clientStartedAt:Date.now()});
    state.busy++;watching.add(submitted.job_id);updateJobs();
    try{
      for(;;){const job=await ipc.invoke('organizer:job',submitted.job_id);state.jobs.set(job.id,{...state.jobs.get(job.id),...job});updateJobs();
        if(job.state==='failed')throw Error(job.error);
        if(job.state==='completed')return job.result;
        await new Promise(resolve=>setTimeout(resolve,600));
      }
    }finally{state.busy--;watching.delete(submitted.job_id);updateJobs();}
  }
  function syncPlanAI(){if(!isActive()||state.screen!=='plan')return;const locked=planIsLocked(state.selected?.uuid);setPlanLocked(container(),locked);const execute=container().querySelector('[data-execute]');if(execute)execute.disabled=locked||state.dirty||!state.checked||Boolean(state.checked.issues?.length);const control=container().querySelector('[data-plan-ai]');if(control)control.textContent=aiRuns.has(state.selected?.uuid)?'AI 后台识别中…':'AI 辅助映射';const feedback=container().querySelector('[data-review-feedback]');if(feedback)feedback.textContent=confirmations.has(state.selected?.uuid)?'正在保存人工确认并检查文件方案…':state.dirty?'调整后请更新检查，当前目标为上次预览':state.checked?.issues?.length?'检查发现问题，请处理标记行':'文件检查通过，核对后可执行';}
  async function confirmCurrent(sources){
    const task=state.selected,plan=state.plan;if(planIsLocked(task.uuid))throw Error('本方案正在处理，请稍后确认');
    const snapshot=JSON.stringify(state.rows),result=confirmMappings(plan,state.rows,sources);
    if(!result.count){notice('没有可确认的完整映射；请先为待确认文件选择归属作品和章节。');return;}
    confirmations.add(task.uuid);syncPlanAI();
    const feedback=container().querySelector('[data-review-feedback]');if(feedback)feedback.textContent='正在保存人工确认并检查文件方案…';
    try{
      const checked=await action('check',{id:task.uuid,revision:plan.revision,rows:result.rows});
      if(isActive()&&state.screen==='plan'&&state.selected?.uuid===task.uuid&&state.plan?.revision===plan.revision&&JSON.stringify(state.rows)===snapshot){state.rows=result.rows;state.checked=checked;state.dirty=false;state.selectedSources.clear();render();}
      notice('已保存 '+result.count+' 个映射的人工确认'+(checked.issues?.length?'；文件检查仍有问题，请继续处理。':'；文件检查通过，可以继续核对或执行入库。'));
    }finally{confirmations.delete(task.uuid);syncPlanAI();}
  }
  function guarded(fn){return async()=>{try{await fn();}catch(error){notice(error.message);}};}
  function jobTitle(job){const names={'deepseek-plan':'AI 辅助映射','deepseek-history':'读取 AI 调用记录','delete-task-preview':'预览删除范围','delete-task':'删除整理记录',recognize:'识别并生成方案',retry:'重新识别',plan:'读取方案',check:'检查文件方案',execute:'执行入库',config:'读取设置','save-config':'保存设置',layout:'预览目录迁移','save-task':'保存识别信息','add-subject':'载入关联条目','subtitle-preview':'匹配字幕','subtitle-execute':'导入字幕','cancel-review':'取消识别方案'};return names[job.action]||job.action;}
  function updateJobs(){if(!isActive())return;const host=container().querySelector('[data-jobs]');if(!host)return;host.replaceChildren();const active=[...state.jobs.values()].filter(j=>['queued','running'].includes(j.state));for(const job of active){const seconds=job.clientStartedAt?Math.floor((Date.now()-job.clientStartedAt)/1000):0;const line=el('div','organizer-job',(job.state==='queued'?'等待执行 · ':'处理中 · ')+(job.progress||jobTitle(job))+(seconds?' · 已等待 '+seconds+' 秒':''));line.setAttribute('role','status');host.appendChild(line);}for(const job of visibleFailures(state.jobs.values(),{dismissed:dismissedJobs,historical:historicalFailures,taskId:state.screen==='tasks'?undefined:state.selected?.uuid})){const line=el('div','organizer-job job-failure');line.setAttribute('role','alert');const message=el('span','job-failure-message',jobTitle(job)+'失败：'+(job.error||'请重试'));const close=button('关闭',()=>{dismissedJobs.add(job.id);saveDismissed(noticeStorage,dismissedJobs);updateJobs();},'button quiet small');close.setAttribute('aria-label','关闭'+jobTitle(job)+'失败提示');line.append(message,close);host.appendChild(line);} }
  async function load(){const data=await ipc.invoke('library:organize');state.tasks=data.tasks;state.loaded=true;for(const job of data.jobs||[]){if(job.state==='failed'&&!state.jobs.has(job.id))historicalFailures.add(job.id);state.jobs.set(job.id,{...state.jobs.get(job.id),...job});if(job.action==='deepseek-plan'&&['queued','running'].includes(job.state))aiRuns.set(job.task_id,true);if(['queued','running'].includes(job.state)&&!watching.has(job.id))resume(job.id);}if(data.errors?.length)notice(data.errors.length+' 条损坏记录未载入');return data;}
  async function resume(id){
    watching.add(id);
    try{for(;;){const job=await ipc.invoke('organizer:job',id);state.jobs.set(id,job);updateJobs();if(['completed','failed'].includes(job.state)){if(job.state==='failed')notice(job.error);await refresh();break;}await new Promise(resolve=>setTimeout(resolve,1000));}}
    catch(error){notice(error.message);}finally{watching.delete(id);const job=state.jobs.get(id);if(job?.action==='deepseek-plan'){aiRuns.delete(job.task_id);syncPlanAI();if(job.state==='completed')notice('AI 识别已完成，重新打开该任务即可查看结果。');}}
  }
  async function refresh(){await load();if(isActive()&&state.screen==='tasks')render();}
  function render(){
    if(!isActive())return;
    setHeader(state.screen==='plan'?'核对整理方案':'资源整理',state.screen==='plan'?'先核对文件与目标，有问题再展开调整。':'添加来源、核对方案，再执行入库。','LIBRARY / ORGANIZE');
    const root=container(),key=state.screen+':'+(state.selected?.uuid||'');
    if(mounted?.root===root&&mounted.key===key&&mounted.body.isConnected){
      updateJobs();
      if(state.screen==='tasks'){refreshTaskList();return;}
      if(state.screen==='plan'&&mounted.plan===state.plan){refreshPlan();return;}
      preserveInteraction(mounted.body,()=>{mounted.body.replaceChildren();if(state.screen==='plan')renderPlan(mounted.body);else if(state.screen==='edit')renderEdit(mounted.body);else if(state.screen==='delete')renderDelete(mounted.body);else renderConfig(mounted.body);});mounted.plan=state.plan;return;
    }
    root.replaceChildren();root.dataset.organizerScreen=state.screen;
    const tabs=controls();tabs.append(button('整理任务',()=>{state.screen='tasks';render();},'button '+(state.screen==='tasks'?'primary':'quiet')),button('整理设置',guarded(async()=>{if(state.screen==='config')return;const config=await action('config',{});state.config=config;state.screen='config';render();}),'button quiet'));if(state.screen!=='plan')root.appendChild(tabs);
    const jobs=el('div');jobs.dataset.jobs='';root.appendChild(jobs);updateJobs();
    const host=el('div','organizer-screen');root.appendChild(host);mounted={root,key,body:host,plan:state.plan};
    if(state.screen==='plan')renderPlan(host);else if(state.screen==='edit')renderEdit(host);else if(state.screen==='delete')renderDelete(host);else if(state.screen==='config')renderConfig(host);else renderTasks(host);
    if(!state.loaded){state.loaded=true;refresh().catch(error=>{state.loaded=false;notice(error.message);});}
  }
  function renderTasks(host){
    const card=el('section','settings-card organizer-add');card.appendChild(el('h3','','添加整理来源'));
    const row=controls(),path=input('');path.placeholder='粘贴下载目录或视频文件路径';path.setAttribute('aria-label','整理来源路径');row.append(path,button('识别并预览',guarded(async()=>{if(!path.value.trim())throw Error('请填写源路径');await submit([path.value.trim()]);}),'button primary'));
    const pick=row;for(const [kind,title]of [['folder','选择目录'],['file','选择视频文件']])pick.appendChild(button(title,guarded(async()=>{const paths=await ipc.invoke('organizer:pick',kind);if(paths.length)await submit(paths);}), 'button quiet'));
    card.append(pick,hint('先预览，确认后再入库。'));host.appendChild(card);
    const bar=controls(),search=input(state.query);search.placeholder='搜索作品、条目 ID 或路径';search.setAttribute('aria-label','搜索整理任务');search.oninput=()=>{state.query=search.value;state.page=0;renderTaskRows(list,pager);};const filter=select([['all','全部状态'],['待审核','待审核'],['需处理','需处理'],['已完成','已完成'],['已取消','已取消']],state.filter);filter.onchange=()=>{state.filter=filter.value;state.page=0;renderTaskRows(list,pager);};bar.append(search,filter,button('刷新任务',guarded(refresh),'button quiet'));host.appendChild(bar);const list=el('div','organizer-task-list'),pager=controls();host.append(list,pager);refreshTaskList=()=>preserveInteraction(list,()=>renderTaskRows(list,pager));renderTaskRows(list,pager);
  }
  async function submit(paths){const before=new Set(state.tasks.map(task=>task.uuid));notice('已接收 '+paths.length+' 个来源，正在生成方案…');for(const path of paths){const promise=action('recognize',{path});updateJobs();const result=await promise;notice(result.message||'识别完成');await load();if(isActive()&&state.screen==='tasks')render();}const pending=state.tasks.filter(t=>t.plan_state==='pending'&&(!before.has(t.uuid)||paths.some(source=>t.path&&require('path').resolve(t.path).toLowerCase()===require('path').resolve(source).toLowerCase())));if(pending.length&&isActive()&&state.screen==='tasks'){state.filter='待审核';state.query='';state.page=0;if(pending.length>1)notice('已生成 '+pending.length+' 个方案，先打开第一个，其余可返回任务列表查看');await openPlan(pending[0]);}}
  function renderTaskRows(list,pager){
    const query=state.query.toLocaleLowerCase();const tasks=state.tasks.filter(t=>(state.filter==='all'||status(t)===state.filter)&&[t.name,t.path,t.bgm_id,t.subject_id].some(v=>String(v??'').toLocaleLowerCase().includes(query)));const pages=Math.max(1,Math.ceil(tasks.length/pageSize));state.page=Math.min(state.page,pages-1);const cards=[],cache=list._taskCards||new Map();pager.replaceChildren();
    if(!tasks.length)cards.push(el('div','empty-state',state.loaded?'暂无匹配任务':'正在读取整理任务…'));
    for(const task of tasks.slice(state.page*pageSize,(state.page+1)*pageSize)){
      const signature=JSON.stringify(task),cached=cache.get(task.uuid);if(cached?.signature===signature){cards.push(cached.card);continue;}
      const card=el('article','organizer-task');const head=el('div','organizer-task-heading');head.append(el('strong','',task.name||require('path').basename(task.path||'未命名')),el('span','organizer-status '+(status(task)==='待审核'?'pending':status(task)==='需处理'?'failed':'done'),status(task)));card.appendChild(head);const source=el('div','organizer-path',task.path);source.title=task.path;card.appendChild(source);
      card.appendChild(hint((task.subject_id||task.bgm_id?'BGM '+(task.subject_id||task.bgm_id)+' · ':'')+(task.layout==='bangumi'?'条目目录':'兼容目录')+(task.subtitle_group?' · '+task.subtitle_group:'')));
      if(task.error&&!['待审核','已取消'].includes(status(task))){const error=el('pre','organizer-error',task.error);card.appendChild(error);}
      const actions=controls();if(task.plan_state==='pending')actions.appendChild(button('审核文件方案',guarded(()=>openPlan(task)),'button primary small'));actions.appendChild(button('修改识别信息',()=>{state.selected=task;state.screen='edit';render();}));actions.appendChild(button('重新识别并预览',guarded(async()=>{await action('retry',{id:task.uuid});await load();const updated=state.tasks.find(t=>t.uuid===task.uuid);if(updated?.plan_state==='pending')await openPlan(updated);else{render();notice('已更新识别结果');}})));
      if(task.can_cancel_review)actions.appendChild(button('取消本次重新识别',guarded(async()=>{const result=await action('cancel-review',{id:task.uuid});await refresh();notice(result.message);}),'button quiet small'));else if(task.plan_state==='pending'&&!task.rollback_blocked)actions.appendChild(button('放弃此方案',guarded(async()=>{const result=await action('cancel-review',{id:task.uuid});await refresh();notice(result.message);}),'button quiet small'));
      actions.appendChild(button('删除记录 / 关联文件',guarded(async()=>{if(state.busy)throw Error('请等待当前任务完成');state.selected=task;state.deletion=await action('delete-task-preview',{id:task.uuid,delete_outputs:false});state.screen='delete';render();}),'button danger small'));
      if(task.layout==='legacy'&&(task.subject_id||task.bgm_id))actions.appendChild(button('预览条目目录迁移',guarded(async()=>{const plan=await action('layout',{id:task.uuid});adoptPlan(task,plan);})));card.appendChild(actions);cards.push(card);cache.set(task.uuid,{signature,card});
    }
    reconcileChildren(list,cards);list._taskCards=cache;
    const prev=button('上一页',()=>{state.page--;renderTaskRows(list,pager);}),next=button('下一页',()=>{state.page++;renderTaskRows(list,pager);});prev.disabled=state.page===0;next.disabled=state.page>=pages-1;pager.append(el('span','',tasks.length+' 条 · '+(state.page+1)+' / '+pages+' 页'),prev,next);
  }
  function renderDelete(host){
    const task=state.selected,preview=state.deletion;
    host.appendChild(button('← 返回整理任务',back,'button quiet'));
    const card=el('section','settings-card');card.append(el('h3','','删除 · '+preview.name),hint('源路径：'+(preview.source||'未记录')));
    const removeOutputs=input('','checkbox');removeOutputs.checked=preview.delete_outputs;
    removeOutputs.onchange=guarded(async()=>{host.inert=true;try{state.deletion=await action('delete-task-preview',{id:task.uuid,delete_outputs:removeOutputs.checked});render();}finally{host.inert=false;}});
    card.append(label('同时将此任务关联的输出文件移入回收站',removeOutputs),hint('默认只移除任务、执行记录及待审核方案，保留输出文件。源文件、其他任务共用文件会保留；删除前会备份记录。'),hint(preview.trash_count+' 个输出将回收 · '+preview.keep_count+' 个输出保留'));
    if(preview.delete_outputs){card.appendChild(hint('回收输出后递归清理空目录，到下面列出的作品目录为止；仍有内容的目录会保留。'));for(const root of preview.cleanup_roots||[])card.appendChild(hint('清理边界：'+root));if(!preview.cleanup_roots?.length)card.appendChild(hint('无法确认作品目录边界，本次保留目录。'));}
    const confirm=button(preview.delete_outputs?'确认删除记录并回收 '+preview.trash_count+' 个文件':'确认仅删除记录',guarded(async()=>{
      if(state.busy)throw Error('请等待当前任务完成');host.inert=true;
      try{const result=await action('delete-task',{id:task.uuid,token:preview.token,delete_outputs:preview.delete_outputs});state.selected=null;state.deletion=null;state.screen='tasks';await load();render();notice(result.message);}
      finally{host.inert=false;}
    }),'button danger');
    const actions=controls();actions.append(button('取消',back,'button quiet'),button('刷新删除清单',guarded(async()=>{host.inert=true;try{state.deletion=await action('delete-task-preview',{id:task.uuid,delete_outputs:preview.delete_outputs});render();}finally{host.inert=false;}}),'button quiet'),confirm);card.appendChild(actions);host.appendChild(card);
    const files=el('details','plan-companions');files.open=true;files.appendChild(el('summary','',preview.rows.length+' 个已登记输出的处理清单'));
    const table=el('table','organizer-preview');for(const row of preview.rows){const tr=el('tr');tr.append(el('td','',row.path),el('td','',row.reason));table.appendChild(tr);}files.appendChild(table);host.appendChild(files);
  }
  function adoptPlan(task,plan){if(!plan||plan.state!=='pending')throw Error('没有可审核的方案，请先重新识别');state.selected=task;state.plan=plan;state.rows=JSON.parse(JSON.stringify(plan.draft_rows||plan.rows));state.checked=plan.review||null;state.dirty=!plan.review;state.rowPage=0;state.reviewQuery='';state.onlyAttention=false;state.reviewFilter='all';state.expanded=new Set();state.selectedSources=new Set();state.screen='plan';render();}
  async function openPlan(task){const plan=await action('plan',{id:task.uuid});adoptPlan(task,plan);}
  function showSource(host,source){
    const box=el('section','organizer-source-card');
    box.append(el('strong','','当前来源 · '+String(source||'').split(/[\\/]/).filter(Boolean).pop()),el('code','',source||'来源未记录'));
    host.appendChild(box);
  }
  function renderEdit(host){
    const task=state.selected;host.appendChild(button('← 返回整理任务',back,'button quiet'));
    showSource(host,task.path);
    const form=el('form','settings-card organizer-form');form.append(el('h3','','确认归属作品'),hint('可勾选多个作品。多归属方案会载入各条目的章节，所有文件先保持待分配。'));
    const changes={},fields=el('div','organizer-form-grid'),advanced=fold('其他识别选项','edit-options:'+task.uuid),advancedFields=el('div','organizer-form-grid'),inputs={};
    for(const [key,title]of [['name','作品名称'],['bgm_id','Bangumi 条目 ID'],['subtitle_group','字幕组'],['tmdb_id','TMDB ID'],['year','年份'],['season_id','TMDB 季号']]){const control=input(task[key]);inputs[key]=control;control.oninput=()=>changes[key]=control.value||null;(new Set(['name','bgm_id','subtitle_group']).has(key)?fields:advancedFields).appendChild(label(title,control));}
    for(const [key,title]of [['is_anime','动画类型'],['is_movie','电影类型']]){const control=select([['','自动'],['true','是'],['false','否']],task[key]===null||task[key]===undefined?'':String(task[key]));control.onchange=()=>changes[key]=control.value===''?null:control.value==='true';advancedFields.appendChild(label(title,control));}
    for(const [key,title]of [['use_ai','AI 辅助识别'],['skip_search','仅使用给定信息']]){const control=input('', 'checkbox');control.checked=Boolean(task[key]);control.onchange=()=>changes[key]=control.checked;const field=label(title,control);field.classList.add('organizer-inline-check');advancedFields.appendChild(field);}
    form.appendChild(fields);
    const selected=new Set((task.subject_ids?.length?task.subject_ids:[task.bgm_id||task.subject_id]).filter(Boolean).map(String));
    const membership=el('section','organizer-membership'),summary=el('div','organizer-selected-subjects'),checks=new Map();
    const names=new Map([...(task.bangumi_candidates||[]).map(c=>[String(c.id||c.subject_id),c.name_cn||c.name]),...(task.selected_subjects||[]).map(c=>[String(c.id),c.name])]);
    function drawSelected(){summary.replaceChildren();summary.appendChild(el('strong','','已选归属 · '+selected.size));for(const id of selected)summary.appendChild(button((names.get(id)||'BGM '+id)+' ×',()=>{selected.delete(id);syncSelection();},'button quiet small'));for(const [id,check]of checks)check.checked=selected.has(id);}
    function syncSelection(){changes.subject_ids=[...selected];changes.bgm_id=[...selected][0]||'';inputs.bgm_id.value=changes.bgm_id;drawSelected();}
    inputs.bgm_id.oninput=()=>{selected.clear();if(inputs.bgm_id.value.trim())selected.add(inputs.bgm_id.value.trim());syncSelection();};
    membership.append(summary,hint('候选可以多选；没有列出的作品可按 Bangumi ID 添加。'));
    const addLine=controls(),addId=input('');addId.placeholder='添加归属作品的 Bangumi ID';addId.setAttribute('aria-label','添加归属作品的 Bangumi ID');
    addLine.append(addId,button('添加归属',()=>{const id=addId.value.trim();if(!/^[1-9]\d*$/.test(id)){notice('请输入有效的 Bangumi ID');return;}if(selected.size>=20&&!selected.has(id)){notice('最多选择二十个归属');return;}selected.add(id);addId.value='';syncSelection();},'button small'));membership.appendChild(addLine);
    if(task.bangumi_candidates?.length){const candidates=el('div','organizer-candidates');candidates.appendChild(el('h4','','匹配候选 · 可多选'));for(const item of task.bangumi_candidates){const id=String(item.id||item.subject_id),row=el('div','organizer-candidate-row'),check=input('','checkbox');check.checked=selected.has(id);check.setAttribute('aria-label','归属作品 '+(item.name_cn||item.name||id));check.onchange=()=>{if(check.checked){if(selected.size>=20){check.checked=false;notice('最多选择二十个归属');return;}selected.add(id);}else selected.delete(id);syncSelection();};checks.set(id,check);const head=el('div','organizer-candidate-head'),choice=el('label','organizer-candidate-choice');choice.append(check,el('span','',item.name_cn||item.name||id));head.append(choice,el('code','organizer-candidate-id','BGM '+id),el('time','organizer-candidate-date',item.date||'日期未知'));row.append(head,el('div','organizer-candidate-original',item.name||''));if(item.recall_evidence?.length){const evidence=el('details','organizer-candidate-evidence');evidence.appendChild(el('summary','','查看匹配依据'));for(const e of item.recall_evidence)evidence.appendChild(hint(e.source==='reading'?'自动读音 · '+e.title:'Tenrai / MAL '+e.mal_id+' · '+e.title+' · 跨库对应分 '+Number(e.match_score||0).toFixed(2)+' / 10'));row.appendChild(evidence);}candidates.appendChild(row);}membership.appendChild(candidates);}
    drawSelected();form.appendChild(membership);
    for(const warning of task.recall_warnings||[])form.appendChild(hint(warning));
    advanced.appendChild(advancedFields);const source=fold('来源路径','edit-source:'+task.uuid);source.appendChild(hint(task.path));form.append(advanced,source);
    const actions=controls();actions.append(button('保存识别信息',guarded(async()=>{await action('save-task',{id:task.uuid,changes});await load();back();notice('识别信息已保存');})),button('生成新方案',guarded(async()=>{await action('retry',{id:task.uuid,changes});await load();const updated=state.tasks.find(t=>t.uuid===task.uuid);if(updated?.plan_state==='pending')await openPlan(updated);else{back();notice('识别结果已更新，请查看任务提示');}}),'button primary'));form.appendChild(actions);form.onsubmit=e=>e.preventDefault();host.appendChild(form);
  }
  function renderPlan(host){
    const plan=state.plan,task=state.selected;const origin=el('div','plan-origin');origin.appendChild(button('← 返回整理任务',back,'button quiet'));showSource(origin,plan.root||task.path);host.appendChild(origin);
    if(aiRuns.has(task.uuid))host.appendChild(hint('AI 正在后台识别。本方案暂时只读，可以筛选、展开文件或返回其他页面；结果完成后再核对。'));
    let items=reviewRows(plan,state.rows,state.checked);const attention=items.filter(item=>item.attention).length,problems=items.filter(item=>!item.row.skip&&item.validationReasons.length).length,confirmed=items.filter(item=>item.confirmed&&!item.row.skip).length;
    const heading=el('section','plan-review-heading');heading.append(el('h3','',(task.name||'文件方案')+' · '+(plan.context.layout_migration?'目录迁移':plan.mode+'入库')),hint(state.rows.length+' 个视频 · '+problems+' 个检查问题 · '+confirmed+' 个已人工确认 · '+state.rows.filter(row=>row.skip).length+' 个跳过。先核对映射，文件检查通过后再执行。'));
    if(plan.context.requires_subject_assignment)heading.append(hint('已选归属：'+[plan.context,...Object.values(plan.context.subjects||{})].map(s=>s.name+' · BGM '+s.subject_id).join('；')),hint('每个文件都需确认归属作品；可按子目录筛选并批量分配，再选择章节。'));
    const steps=el('div','organizer-steps');for(const text of ['1 识别来源','2 核对方案','3 执行入库'])steps.appendChild(el('span',text.startsWith('2')?'current':'',text));heading.prepend(steps);host.appendChild(heading);
    const actions=controls();actions.classList.add('plan-review-actions');actions.dataset.planMutation='';
    const feedback=el('span','plan-check-feedback',state.dirty?'调整后请更新检查，当前目标为上次预览':state.checked?.issues?.length?'检查发现问题，请处理标记行':'检查通过，核对后可执行');feedback.dataset.reviewFeedback='';
    const check=button('更新检查',guarded(async()=>{check.disabled=true;try{const snapshot=JSON.stringify(state.rows);const checked=await action('check',{id:task.uuid,revision:plan.revision,rows:JSON.parse(snapshot)});if(snapshot!==JSON.stringify(state.rows)){invalid();notice('检查期间方案已变化，请重新检查');return;}state.checked=checked;state.dirty=false;render();}finally{check.disabled=false;}}));
    const execute=button('执行入库',guarded(async()=>{if(state.dirty||!state.checked||state.checked.issues.length)throw Error('请先更新检查');execute.disabled=true;await action('execute',{id:task.uuid,revision:plan.revision,rows:state.rows,token:state.checked.token});await load();back();notice('整理完成，媒体库已更新');}),'button primary');execute.dataset.execute='';execute.disabled=state.dirty||!state.checked||Boolean(state.checked.issues.length);const cancel=button(plan.can_rollback?'取消本次重新识别':'放弃此方案',guarded(async()=>{cancel.disabled=true;execute.disabled=true;check.disabled=true;try{const result=await action('cancel-review',{id:task.uuid,revision:plan.revision});await load();back();notice(result.message);}finally{cancel.disabled=false;check.disabled=false;execute.disabled=state.dirty||!state.checked||Boolean(state.checked.issues.length);}}),'button quiet');
    cancel.disabled=Boolean(plan.rollback_blocked);actions.append(feedback,check,execute);host.appendChild(actions);
    const secondary=el('div','plan-secondary-tools');host.appendChild(secondary);const tools=fold('AI 辅助与方案管理','plan-tools:'+task.uuid);secondary.appendChild(tools);const management=controls();management.dataset.planMutation='';management.appendChild(cancel);tools.appendChild(management);
    if(plan.rollback_blocked)tools.appendChild(hint('识别后的操作记录已变化，不能通过取消识别回退，请先核对执行记录。'));else if(!plan.can_rollback)tools.appendChild(hint('此方案没有重新识别前的快照：可放弃方案并保留现有文件，但无法完整恢复更早的识别信息。'));
    if(plan.context.layout==='bangumi'){
      const aiBar=controls(),scope=select([['unresolved','仅补全未映射章节'],['all','复核全部自动映射']],state.aiScope||'unresolved');
      scope.onchange=()=>state.aiScope=scope.value;
      const model=select([['glm-5.3-flash','GLM-5.3-Flash · 赠送额度'],['glm-5.3-flashx','GLM-5.3-FlashX · 赠送额度'],['glm-4-flash-250414','GLM-4-Flash · 免费'],['deepseek-flash','DeepSeek · 按量计费']],state.aiModel||plan.ai_default_model||'deepseek-flash');
      model.setAttribute('aria-label','方案辅助模型');state.aiModel=model.value;model.onchange=()=>state.aiModel=model.value;
      aiBar.dataset.planMutation='';
      const ai=button(aiRuns.has(task.uuid)?'AI 后台识别中…':'AI 辅助映射',guarded(async()=>{
        const rows=JSON.parse(JSON.stringify(state.rows));
        await runPlanAI({pending:aiRuns,task,plan,rows,scope:scope.value,
          request:()=>action('deepseek-plan',{id:task.uuid,revision:plan.revision,rows,scope:scope.value,model:model.value}),
          isCurrent:()=>isActive()&&state.screen==='plan'&&state.selected?.uuid===task.uuid&&state.plan?.revision===plan.revision,
          apply:result=>adoptPlan(task,result),
          notify:notice,
          sync:syncPlanAI
        });
      }),'button quiet');
      ai.dataset.planAi='';aiBar.append(model,scope,ai);tools.append(el('h4','','AI 辅助映射'),aiBar,hint('仅手动触发，向所选平台发送相对文件名和章节列表，不上传视频。赠送模型消耗资源包，实际剩余额度以平台为准；免费模型不收模型调用费。保留手动修改和跳过项，每次最多100个文件。'));
      if(plan.ai_review){const usage=plan.ai_review;tools.appendChild(hint((usage.model||'DeepSeek')+' · '+usage.files+' 个文件 · '+usage.attempts+' 次请求 · '+(usage.billing==='free'?'免费模型':usage.billing==='gift'?'赠送额度模型；抵扣前目录价约 ¥'+Number(usage.estimated_cny||0).toFixed(4):'高峰价估算 ¥'+Number(usage.estimated_cny||0).toFixed(4))+'；实际用量与费用以平台为准'));}
    }
    if(plan.context.layout==='bangumi'){const line=controls(),id=input('');line.dataset.planMutation='';id.placeholder='输入关联作品的 Bangumi ID';line.append(id,button('载入关联条目',guarded(async()=>{const context=await action('add-subject',{id:task.uuid,revision:plan.revision,subject_id:id.value});state.plan=context;invalid();render();})));const assignment=fold('添加其他归属作品','assignment:'+task.uuid,Boolean(plan.context.requires_subject_assignment));assignment.append(hint('载入其他作品后，可在文件的章节映射中切换归属作品。'),line);secondary.appendChild(assignment);}
    const bar=controls();bar.classList.add('plan-file-filter');
    const search=input(state.reviewQuery||'');search.placeholder='搜索源文件、作品、章节或目标…';search.setAttribute('aria-label','筛选方案文件');
    const filter=select([['all','全部文件'],['attention','需核对'],['confirm','映射待确认'],['problems','文件检查问题'],['confirmed','已人工确认'],['skipped','已跳过']],state.reviewFilter||'all');filter.setAttribute('aria-label','筛选方案状态');
    const rowsHost=el('div','plan-review-list'),pager=controls();pager.className+=' plan-pager';
    const batch=controls();batch.classList.add('plan-batch-actions');batch.dataset.planMutation='';
    let filteredRows=[];
    const selection=button('全选筛选结果',()=>{for(const item of filteredRows)state.selectedSources.add(item.row.source);drawRows();},'button quiet small');selection.dataset.planMutation='';
    const confirmFiltered=button('确认筛选映射',guarded(()=>confirmCurrent(filteredRows.filter(item=>item.canConfirm).map(item=>item.row.source))),'button small');confirmFiltered.dataset.planMutation='';confirmFiltered.title='确认当前筛选下的完整映射，包含其他分页；不会执行入库。';
    function drawBatch(){
      batch.replaceChildren();batch.hidden=!state.selectedSources.size;if(batch.hidden)return;
      batch.appendChild(el('span','','已选 '+state.selectedSources.size+' 个视频'));
      if(plan.context.layout==='bangumi'){
        const count=items.filter(item=>state.selectedSources.has(item.row.source)&&item.canConfirm).length;
        const confirm=button('确认选中映射（'+count+'）',guarded(()=>confirmCurrent([...state.selectedSources])),'button primary small');confirm.disabled=!count;batch.appendChild(confirm);
        const subjects={[String(plan.context.subject_id)]:plan.context,...plan.context.subjects};const assign=select([['','批量选择归属作品'],...Object.entries(subjects).map(([id,s])=>[id,s.name+' · '+id])],'');assign.onchange=()=>{if(!assign.value)return;state.rows=state.rows.map(row=>state.selectedSources.has(row.source)?{...row,subject_id:assign.value,episode_id:null,episode_ids:[],category:'unresolved',manual_mapping:true}:row);state.selectedSources.clear();invalid();render();};batch.appendChild(assign);
      }
      for(const [kind,text]of [['extra','归为附加资源'],['skip','跳过选中文件']]){if(kind==='extra'&&plan.context.layout!=='bangumi')continue;batch.appendChild(button(text,()=>{state.rows=batchRows(state.rows,state.selectedSources,kind);state.selectedSources.clear();invalid();render();},'button small'));}
      batch.appendChild(button('取消选择',()=>{state.selectedSources.clear();drawRows();},'button quiet small'));setPlanLocked(host,planIsLocked(task.uuid));
    }
    const rowCache=new Map();
    function drawRows(){
      const query=(state.reviewQuery||'').toLocaleLowerCase();
      filteredRows=items.filter(item=>{
        const mode=state.reviewFilter||'all';if(mode==='attention'&&!item.attention||mode==='confirm'&&(item.confirmed||item.row.skip)||mode==='problems'&&(!item.validationReasons.length||item.row.skip)||mode==='confirmed'&&!item.confirmed||mode==='skipped'&&!item.row.skip)return false;
        return [item.row.source,item.target,describeMapping(plan,item.row),...item.reasons].some(value=>String(value).toLocaleLowerCase().includes(query));
      });
      const pages=Math.max(1,Math.ceil(filteredRows.length/40));state.rowPage=Math.min(state.rowPage||0,pages-1);pager.replaceChildren();
      const cards=[];
      for(const item of filteredRows.slice(state.rowPage*40,(state.rowPage+1)*40)){
        const signature=JSON.stringify(item),cached=rowCache.get(item.row.source);
        if(cached?.signature===signature&&cached.row===item.row){cards.push(cached.card);continue;}
        const fragment=el('div'),card=renderPlanRow(fragment,item.row,plan,item,drawBatch,()=>refreshPlan());
        rowCache.set(item.row.source,{signature,card,row:item.row});cards.push(card);
      }
      reconcileChildren(rowsHost,cards);
      if(!filteredRows.length)rowsHost.appendChild(hint('没有符合条件的视频，试试其他关键词或状态。'));
      const prev=button('上一页',()=>{state.rowPage--;drawRows();}),next=button('下一页',()=>{state.rowPage++;drawRows();});prev.disabled=!state.rowPage;next.disabled=state.rowPage>=pages-1;
      pager.append(el('span','',filteredRows.length+' 个视频 · '+(state.rowPage+1)+' / '+pages+' 页'),prev,next);selection.disabled=!filteredRows.length;
      const count=filteredRows.filter(item=>item.canConfirm).length;confirmFiltered.textContent='确认筛选映射（'+count+'）';confirmFiltered.disabled=!count;confirmFiltered.hidden=plan.context.layout!=='bangumi';
      drawBatch();setPlanLocked(host,planIsLocked(task.uuid));
    }
    search.oninput=()=>{state.reviewQuery=search.value;state.rowPage=0;drawRows();};filter.onchange=()=>{state.reviewFilter=filter.value;state.rowPage=0;drawRows();};
    bar.append(el('strong','','文件清单'),search,filter,selection,confirmFiltered);
    const legend=hint('映射正确可直接确认，无需重选章节。确认会保存并更新文件检查；冲突、缺失等检查问题仍需单独解决。');legend.className+=' plan-review-help';
    host.append(bar,legend,batch,rowsHost,pager);
    refreshPlan=()=>preserveInteraction(host,()=>{
      items=reviewRows(plan,state.rows,state.checked);
      heading.querySelector('p').textContent=state.rows.length+' 个视频 · '+items.filter(item=>!item.row.skip&&item.validationReasons.length).length+' 个检查问题 · '+items.filter(item=>item.confirmed&&!item.row.skip).length+' 个已人工确认 · '+state.rows.filter(row=>row.skip).length+' 个跳过。先核对映射，文件检查通过后再执行。';
      execute.disabled=state.dirty||!state.checked||Boolean(state.checked.issues?.length);syncPlanAI();drawRows();drawCompanions();
    });drawRows();
    const companionHost=el('div');host.appendChild(companionHost);
    function drawCompanions(){companionHost.replaceChildren();const companions=(state.checked?.preview||[]).filter(item=>!state.rows.some(row=>row.source===item.source));if(companions.length){const section=el('details','plan-companions');section.appendChild(el('summary','',companions.length+' 个关联字幕 / 音轨映射'));const table=el('table','organizer-preview');for(const item of companions){const tr=el('tr');for(const value of [item.source_label,item.target_label,item.action])tr.appendChild(el('td','',value));table.appendChild(tr);}section.appendChild(table);companionHost.appendChild(section);}}drawCompanions();
  }
  function renderPlanRow(host,row,plan,item,onSelection,onChange){
    const card=el('details','plan-review-row'+(item.attention?' needs-attention':'')+(row.skip?' skipped':''));card.open=state.expanded.has(row.source);card.ontoggle=()=>{if(!card.isConnected)return;if(card.open){state.expanded.add(row.source);mountEditor();}else state.expanded.delete(row.source);};
    const summary=el('summary','plan-review-summary');
    const source=el('span','plan-row-source',require('path').basename(row.source));source.title=row.source;
    const target=el('div','plan-row-destination');target.append(el('strong','plan-row-mapping',describeMapping(plan,row)),el('small','plan-row-target',row.skip?'保持原样':item.targetLabel));target.title=item.target||item.reasons.join('；');
    const selectRow=input('','checkbox');selectRow.className='plan-select-row';selectRow.checked=state.selectedSources.has(row.source);selectRow.setAttribute('aria-label','选择 '+require('path').basename(row.source));selectRow.onclick=e=>e.stopPropagation();selectRow.onkeydown=e=>{if(e.key===' ')e.stopPropagation();};selectRow.onchange=()=>{if(selectRow.checked)state.selectedSources.add(row.source);else state.selectedSources.delete(row.source);onSelection();};
    const statusText=row.skip?'已跳过':item.validationReasons.length?'检查问题':item.confirmed?'已人工确认':item.attention?'映射待确认':item.status;
    const status=el('span','plan-row-status',statusText);status.className+=' '+(item.validationReasons.length?'problem':item.confirmed?'confirmed':item.attention?'pending':'');
    const actions=el('div','plan-row-quick-actions');actions.dataset.planMutation='';
    if(plan.context.layout==='bangumi'&&!row.skip){const confirm=button(item.confirmed?'已确认':'确认映射',guarded(()=>confirmCurrent([row.source])),'button small '+(item.confirmed?'quiet':'primary'));confirm.disabled=!item.canConfirm;confirm.setAttribute('aria-label',(item.confirmed?'已确认 ':'确认映射 ')+require('path').basename(row.source));confirm.title=item.canConfirm?'保留当前归属与章节，保存人工确认；不执行文件操作。':item.confirmed?'当前映射已人工确认':'请先选择有效的归属作品与章节，或归为附加资源。';confirm.onclick=((handler)=>event=>{event.preventDefault();event.stopPropagation();return handler();})(confirm.onclick);actions.appendChild(confirm);}
    summary.append(selectRow,source,el('span','plan-row-arrow','→'),target,status,actions);card.appendChild(summary);
    if(item.attention){const warning=el('small','plan-row-problem',item.reasons[0]);warning.title=item.reasons.join('；');summary.appendChild(warning);}
    function mountEditor(){if(card.dataset.loaded)return;card.dataset.loaded='true';
    const body=el('div','plan-row-editor');for(const reason of item.reasons)body.appendChild(el('p','plan-row-warning',reason));const paths=fold('路径与识别依据','evidence:'+row.source);paths.append(hint('源文件：'+row.source),hint('最终目标：'+(item.target||'待确认')));const recognition=row.recognition;
    if(recognition){
      const evidence=(recognition.evidence||[]).map(item=>item.text.trim()+' → '+(item.kind==='extra'?'附加资源':item.number));
      if(evidence.length)paths.appendChild(hint('文件名集号依据：'+evidence.join('；')));
      const roles={group:'发布组',group_candidate:'发布组候选',title:'作品名',technical:'技术参数',checksum:'校验值',year:'年份'};
      const excluded=(recognition.fields||[]).map(item=>(roles[item.role]||item.role)+' '+item.text);
      if(excluded.length)paths.appendChild(hint('已排除的元数据：'+excluded.join('；')));
    }
    const mapping=fold('修改章节映射','mapping:'+row.source,!item.canConfirm&&!item.confirmed&&!row.skip);if(row.ai)body.appendChild(hint((row.ai.model||'AI')+' · '+row.ai.confidence+' 置信度 · '+row.ai.reason));const grid=el('div','organizer-form-grid');
    const mappingSummary=el('div','plan-mapping-summary');
    if(plan.context.layout==='bangumi'){const subjects={[String(plan.context.subject_id)]:plan.context,...plan.context.subjects},subject=subjects[String(row.subject_id||(plan.context.requires_subject_assignment?'':plan.context.subject_id))],ep=subject?.episodes?.find(ep=>String(ep.id)===String(row.episode_id));mappingSummary.append(el('span','mapping-badge',({episode:'章节',collection:'合集',extra:'附加资源',unresolved:'待确认'})[row.category]||'待确认'),el('span','',subject?.name||'未选择作品'),el('span','',row.category==='collection'?(row.episode_ids?.length||0)+' 个章节':ep?(ep.sort+' · '+(ep.name_cn||ep.name||'')):'编辑映射可调整归属'));}
    else mappingSummary.textContent='季号 '+(row.season??'未定')+' · 集号 '+(row.episode??'未定');
    body.appendChild(mappingSummary);
    if(plan.context.layout==='bangumi'){
      const subjects={[String(plan.context.subject_id)]:plan.context,...plan.context.subjects};const sid=String(row.subject_id||(plan.context.requires_subject_assignment?'':plan.context.subject_id));const subject=select([...(plan.context.requires_subject_assignment?[['','请选择归属作品']]:[]),...Object.entries(subjects).map(([id,s])=>[id,s.name+' · '+id])],sid);subject.setAttribute('aria-label','归属作品 '+row.source);subject.onchange=()=>{row.manual_mapping=true;row.subject_id=subject.value;row.episode_id=null;row.episode_ids=[];row.category='unresolved';invalid();onChange();};if(Object.keys(subjects).length>1)grid.appendChild(label('归属作品',subject));
      const category=select([['episode','匹配章节'],['collection','合集（正篇）'],['extra','附加资源'],['unresolved','待确认']],row.category);category.setAttribute('aria-label','资源类型 '+row.source);category.onchange=()=>{row.manual_mapping=true;row.category=category.value;if(row.category==='collection'){row.episode_id=null;row.episode_ids=(subjects[sid]?.episodes||[]).map(ep=>Number(ep.id));row.collection_selection_initialized=true;}invalid();onChange();};grid.appendChild(label('资源类型',category));
      const types={0:'本篇',1:'特别篇',2:'OP',3:'ED',4:'预告',5:'MAD',6:'其他'};
      const catalog=subjects[sid]?.episodes||[];
      const chapterTitle=ep=>(types[ep.type]||'其他')+' '+ep.sort+' · '+(ep.name_cn||ep.name||'未命名章节');
      if(row.category==='collection'){
        if(!Array.isArray(row.episode_ids)||(!row.episode_ids.length&&!row.collection_selection_initialized)){row.episode_ids=catalog.map(ep=>Number(ep.id));row.episode_id=null;invalid();}
        row.collection_selection_initialized=true;
        const field=el('div','organizer-field organizer-collection-field'),toolbar=el('div','collection-picker-toolbar'),count=el('span'),choices=el('div','collection-picker-list');
        const checks=[];
        function updateSelection(){row.manual_mapping=true;row.episode_id=null;row.episode_ids=checks.filter(check=>check.checked).map(check=>Number(check.value));updateCount();invalid();}
        function updateCount(){count.textContent='已选 '+checks.filter(check=>check.checked).length+' / '+catalog.length+' 章';}
        const all=button('全选',()=>{checks.forEach(check=>check.checked=true);updateSelection();},'button quiet small');
        const clear=button('清空',()=>{checks.forEach(check=>check.checked=false);updateSelection();},'button quiet small');
        toolbar.append(count,all,clear);
        const selected=new Set(row.episode_ids.map(String));
        for(const ep of catalog){const choice=el('label','collection-picker-choice'),check=input('','checkbox');check.value=String(ep.id);check.checked=selected.has(check.value);check.onchange=updateSelection;checks.push(check);choice.append(check,el('span','',chapterTitle(ep)));choices.appendChild(choice);}
        updateCount();field.append(el('span','','合集包含的章节'),toolbar,choices,hint(catalog.length?'点击勾选即可调整，至少选择两章。':'当前条目暂无章节，请先载入章节。'));grid.appendChild(field);
      }else if(row.category!=='extra'){
        const episodes=select([['','请选择章节'],...catalog.map(ep=>[String(ep.id),chapterTitle(ep)])],String(row.episode_id||''));
        episodes.setAttribute('aria-label','Bangumi 章节 '+row.source);episodes.onchange=()=>{row.manual_mapping=true;row.episode_id=episodes.value||null;if(row.episode_id){row.category='episode';category.value='episode';}invalid();onChange();};grid.appendChild(label('Bangumi 章节',episodes));
      }
    }else for(const [key,title]of [['season','季号'],['episode','集号']]){const control=input(row[key],'number');control.min=key==='season'?0:1;control.oninput=()=>{row[key]=control.value===''?null:Number(control.value);invalid();};grid.appendChild(label(title,control));}
    mapping.appendChild(grid);body.appendChild(mapping);
    const naming=fold('命名选项','naming:'+row.source,Boolean(row.version||row.filename)),names=el('div','organizer-form-grid');
    for(const [key,title]of [['version','版本标识'],['filename','自定义标题（自动补字幕组和扩展名）']]){const control=input(row[key]);control.oninput=()=>{row.manual_mapping=true;row[key]=control.value;invalid();};names.appendChild(label(title,control));}naming.appendChild(names);body.append(naming,paths);const skip=input('','checkbox');skip.checked=Boolean(row.skip);skip.onchange=()=>{row.skip=skip.checked;card.classList.toggle('skipped',row.skip);invalid();};const skipLabel=label('跳过此视频及关联字幕',skip);skipLabel.classList.add('organizer-inline-check');body.appendChild(skipLabel);card.appendChild(body);setPlanLocked(container(),planIsLocked(state.selected?.uuid));}
    if(card.open)mountEditor();host.appendChild(card);return card;
  }
  function renderConfig(host){
    const config=state.config,form=el('form','settings-card organizer-form'),changes={};form.onsubmit=e=>e.preventDefault();form.appendChild(el('h3','','整理设置'));const groups=[['媒体库路径',[['anime_path','动画剧集目录'],['anime_movie_path','动画电影目录'],['bangumi_path','其他剧集目录'],['movie_path','其他电影目录']]],['识别与执行',[['mode','文件处理方式'],['api_key','TMDB API 密钥'],['episode_offset','跨季集数偏移']]],['AI 识别',[['ai_enabled','启用 AI'],['ai_provider','AI 提供商'],['ai_confidence_threshold','置信度阈值'],['ai_api_key','OpenAI 兼容 API 密钥'],['ai_base_url','API 地址'],['ai_model','模型'],['openai_output_format','输出格式'],['gemini_api_key','Gemini API 密钥'],['gemini_base_url','Gemini API 地址'],['gemini_model','Gemini 模型'],['ai_auto_save','保存 AI 分析']]]];
    for(const [title,fields]of groups){const section=fold(title,'config:'+title,title==='媒体库路径');form.appendChild(section);const grid=el('div','organizer-form-grid');for(const [key,text]of fields){let control;
      const options={mode:[['链接','硬链接'],['复制','复制'],['剪切','移动']],ai_provider:[['openai','OpenAI 兼容'],['gemini','Gemini']],ai_confidence_threshold:[['High','High'],['Medium','Medium'],['Low','Low']],openai_output_format:[['function_calling','Function Calling'],['json_object','JSON Object'],['structured_output','Structured Output'],['text','Text']]};
      if(options[key])control=select(options[key],config[key]);else if(typeof config[key]==='boolean'){control=input('','checkbox');control.checked=config[key];}else control=input(config[key],key.includes('api_key')?'password':typeof config[key]==='number'?'number':'text');control.onchange=()=>{changes[key]=control.type==='checkbox'?control.checked:control.type==='number'?Number(control.value):control.value;};grid.appendChild(label(text,control));}section.appendChild(grid);}
    const deepseek=fold('AI · 方案辅助映射','config:deepseek');form.appendChild(deepseek);deepseek.append(hint('在待审核方案里手动调用，独立于上方旧版 AI 开关。GLM-5.3 系列使用低强度思考，GLM-4-Flash 为免费备选。'));
    const nativeModel=select([['glm-5.3-flash','GLM-5.3-Flash · 赠送额度'],['glm-5.3-flashx','GLM-5.3-FlashX · 赠送额度'],['glm-4-flash-250414','GLM-4-Flash · 免费'],['deepseek-flash','DeepSeek · 按量计费']],config.plan_ai_model||'deepseek-flash');nativeModel.onchange=()=>changes.plan_ai_model=nativeModel.value;deepseek.appendChild(label('默认方案辅助模型',nativeModel));
    const deepseekKey=input('','password');deepseekKey.autocomplete='new-password';deepseekKey.placeholder=config.deepseek_key_configured?'已保存密钥，留空保持原值':'填写 DeepSeek API Key';deepseekKey.onchange=()=>{changes.deepseek_api_key=deepseekKey.value.trim();};deepseek.appendChild(label('DeepSeek API Key（仅本机保存）',deepseekKey));
    const glmKey=input('','password');glmKey.autocomplete='new-password';glmKey.placeholder=config.bigmodel_key_configured?'已保存密钥，留空保持原值':'填写智谱 API Key';glmKey.onchange=()=>{changes.bigmodel_api_key=glmKey.value.trim();};deepseek.appendChild(label('智谱 API Key（仅本机保存）',glmKey));
    if(config.glm_gift_expires)deepseek.appendChild(hint('赠送模型到期检查：'+config.glm_gift_expires+'。到期后阻止调用，请改选免费模型。额度余额需在智谱平台查看。'));
    const history=el('div');deepseek.append(button('查看最近 AI 调用记录',guarded(async()=>{const records=await action('deepseek-history',{});history.replaceChildren();for(const run of records)history.appendChild(hint(run.time+' · '+(run.state==='completed'?'完成':run.state==='failed'?'失败':'未完成')+' · '+run.files+' 个文件 · '+run.attempts.length+' 次请求 · 已知用量按高峰单价估算 ¥'+Number(run.estimated_cny||0).toFixed(4)+(run.attempts.some(a=>a.input_tokens===undefined)?' · 部分请求未返回用量，实际费用以账单为准':'')));if(!records.length)history.appendChild(hint('暂无调用记录'));}),'button quiet'),history);
    form.append(hint('设置对后续识别生效，已生成的方案保留创建时的处理方式。'),button('保存整理设置',guarded(async()=>{await action('save-config',{changes});Object.assign(config,changes);if('deepseek_api_key' in changes){config.deepseek_key_configured=Boolean(changes.deepseek_api_key);config.deepseek_api_key='';delete changes.deepseek_api_key;deepseekKey.value='';deepseekKey.placeholder=config.deepseek_key_configured?'已保存密钥，留空保持原值':'填写 DeepSeek API Key';}if('bigmodel_api_key' in changes){config.bigmodel_key_configured=Boolean(changes.bigmodel_api_key);config.bigmodel_api_key='';delete changes.bigmodel_api_key;glmKey.value='';glmKey.placeholder=config.bigmodel_key_configured?'已保存密钥，留空保持原值':'填写智谱 API Key';}if(changes.plan_ai_model)state.aiModel=changes.plan_ai_model;notice('整理设置已保存');}),'button primary'));host.appendChild(form);
  }
  return {render,refresh};
}
module.exports={create};
