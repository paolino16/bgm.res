'use strict';
// Native desktop views; the Python process supplies data and executes reviewed plans only.
function create({ipc,node,button,notice,setHeader,container,isActive}){
  const state={tasks:[],jobs:new Map(),query:'',filter:'all',page:0,screen:'tasks',selected:null,plan:null,rows:[],checked:null,dirty:true,busy:0,loaded:false};
  const {reviewRows}=require('./plan-review.cjs');
  const pageSize=30;
  const watching=new Set();
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
    const submitted=await ipc.invoke('organizer:action',{action,body});
    state.jobs.set(submitted.job_id,{id:submitted.job_id,action,state:'queued',task_id:body?.id});
    state.busy++;watching.add(submitted.job_id);
    try{
      for(;;){const job=await ipc.invoke('organizer:job',submitted.job_id);state.jobs.set(job.id,job);updateJobs();
        if(job.state==='failed')throw Error(job.error);
        if(job.state==='completed')return job.result;
        await new Promise(resolve=>setTimeout(resolve,600));
      }
    }finally{state.busy--;watching.delete(submitted.job_id);updateJobs();}
  }
  function guarded(fn){return async()=>{try{await fn();}catch(error){notice(error.message);}};}
  function jobTitle(job){const names={recognize:'识别并生成方案',retry:'重新识别',plan:'读取方案',check:'检查文件方案',execute:'执行入库',config:'读取设置','save-config':'保存设置',layout:'预览目录迁移','save-task':'保存识别信息','add-subject':'载入关联条目','subtitle-preview':'匹配字幕','subtitle-execute':'导入字幕','cancel-review':'取消识别方案'};return names[job.action]||job.action;}
  function updateJobs(){if(!isActive())return;const host=container().querySelector('[data-jobs]');if(!host)return;host.replaceChildren();const active=[...state.jobs.values()].filter(j=>['queued','running'].includes(j.state));for(const job of active)host.appendChild(el('div','organizer-job',(job.state==='queued'?'等待执行 · ':'处理中 · ')+jobTitle(job)));}
  async function load(){const data=await ipc.invoke('library:organize');state.tasks=data.tasks;state.loaded=true;for(const job of data.jobs||[]){state.jobs.set(job.id,job);if(['queued','running'].includes(job.state)&&!watching.has(job.id))resume(job.id);}if(data.errors?.length)notice(data.errors.length+' 条损坏记录未载入');return data;}
  async function resume(id){
    watching.add(id);
    try{for(;;){const job=await ipc.invoke('organizer:job',id);state.jobs.set(id,job);updateJobs();if(['completed','failed'].includes(job.state)){if(job.state==='failed')notice(job.error);await refresh();break;}await new Promise(resolve=>setTimeout(resolve,1000));}}
    catch(error){notice(error.message);}finally{watching.delete(id);}
  }
  async function refresh(){await load();if(isActive()&&state.screen==='tasks')render();}
  function render(){
    if(!isActive())return;
    setHeader('资源整理','添加来源、确认作品与章节，核对方案后入库。','LIBRARY / ORGANIZE');
    const host=container();host.replaceChildren();const tabs=controls();tabs.append(button('整理任务',()=>{state.screen='tasks';render();},'button '+(state.screen==='tasks'?'primary':'quiet')),button('整理设置',guarded(async()=>{const config=await action('config',{});state.config=config;state.screen='config';render();}),'button quiet'));host.appendChild(tabs);const jobs=el('div');jobs.dataset.jobs='';host.appendChild(jobs);updateJobs();
    if(state.screen==='plan')renderPlan(host);else if(state.screen==='edit')renderEdit(host);else if(state.screen==='config')renderConfig(host);else renderTasks(host);
    if(!state.loaded){state.loaded=true;refresh().catch(error=>{state.loaded=false;notice(error.message);});}
  }
  function renderTasks(host){
    const card=el('section','settings-card organizer-add');card.appendChild(el('h3','','添加整理来源'));
    const row=controls(),path=input('');path.placeholder='粘贴下载目录或视频文件路径';path.setAttribute('aria-label','整理来源路径');row.append(path,button('识别并预览',guarded(async()=>{if(!path.value.trim())throw Error('请填写源路径');await submit([path.value.trim()]);}),'button primary'));card.appendChild(row);
    const pick=controls();for(const [kind,title]of [['folder','选择目录'],['file','选择视频文件']])pick.appendChild(button(title,guarded(async()=>{const paths=await ipc.invoke('organizer:pick',kind);if(paths.length)await submit(paths);}), 'button quiet'));
    card.append(pick,hint('识别阶段只生成待审核方案；检查通过并点击“执行入库”后才操作媒体文件。重复来源沿用已有任务。'));host.appendChild(card);
    const bar=controls(),search=input(state.query);search.placeholder='搜索作品、条目 ID 或路径';search.setAttribute('aria-label','搜索整理任务');search.oninput=()=>{state.query=search.value;state.page=0;renderTaskRows(list,pager);};const filter=select([['all','全部状态'],['待审核','待审核'],['需处理','需处理'],['已完成','已完成'],['已取消','已取消']],state.filter);filter.onchange=()=>{state.filter=filter.value;state.page=0;renderTaskRows(list,pager);};bar.append(search,filter,button('刷新任务',guarded(refresh),'button quiet'));host.appendChild(bar);const list=el('div','organizer-task-list'),pager=controls();host.append(list,pager);renderTaskRows(list,pager);
  }
  async function submit(paths){const before=new Set(state.tasks.map(task=>task.uuid));notice('已接收 '+paths.length+' 个来源，正在生成方案…');for(const path of paths){const promise=action('recognize',{path});updateJobs();const result=await promise;notice(result.message||'识别完成');await load();if(isActive()&&state.screen==='tasks')render();}const pending=state.tasks.filter(t=>t.plan_state==='pending'&&(!before.has(t.uuid)||paths.some(source=>t.path&&require('path').resolve(t.path).toLowerCase()===require('path').resolve(source).toLowerCase())));if(pending.length&&isActive()&&state.screen==='tasks'){state.filter='待审核';state.query='';state.page=0;if(pending.length>1)notice('已生成 '+pending.length+' 个方案，先打开第一个，其余可返回任务列表查看');await openPlan(pending[0]);}}
  function renderTaskRows(list,pager){
    const query=state.query.toLocaleLowerCase();const tasks=state.tasks.filter(t=>(state.filter==='all'||status(t)===state.filter)&&[t.name,t.path,t.bgm_id,t.subject_id].some(v=>String(v??'').toLocaleLowerCase().includes(query)));const pages=Math.max(1,Math.ceil(tasks.length/pageSize));state.page=Math.min(state.page,pages-1);list.replaceChildren();pager.replaceChildren();
    if(!tasks.length)list.appendChild(el('div','empty-state',state.loaded?'暂无匹配任务':'正在读取整理任务…'));
    for(const task of tasks.slice(state.page*pageSize,(state.page+1)*pageSize)){
      const card=el('article','organizer-task');const head=el('div','organizer-task-heading');head.append(el('strong','',task.name||require('path').basename(task.path||'未命名')),el('span','organizer-status '+(status(task)==='待审核'?'pending':status(task)==='需处理'?'failed':'done'),status(task)));card.appendChild(head);const source=el('div','organizer-path',task.path);source.title=task.path;card.appendChild(source);
      card.appendChild(hint((task.subject_id||task.bgm_id?'BGM '+(task.subject_id||task.bgm_id)+' · ':'')+(task.layout==='bangumi'?'条目目录':'兼容目录')+(task.subtitle_group?' · '+task.subtitle_group:'')));
      if(task.error&&!['待审核','已取消'].includes(status(task))){const error=el('pre','organizer-error',task.error);card.appendChild(error);}
      const actions=controls();if(task.plan_state==='pending')actions.appendChild(button('审核文件方案',guarded(()=>openPlan(task)),'button primary small'));actions.appendChild(button('修改识别信息',()=>{state.selected=task;state.screen='edit';render();}));actions.appendChild(button('重新识别并预览',guarded(async()=>{await action('retry',{id:task.uuid});await load();const updated=state.tasks.find(t=>t.uuid===task.uuid);if(updated?.plan_state==='pending')await openPlan(updated);else{render();notice('已更新识别结果');}})));
      if(task.can_cancel_review)actions.appendChild(button('取消本次重新识别',guarded(async()=>{const result=await action('cancel-review',{id:task.uuid});await refresh();notice(result.message);}),'button quiet small'));else if(task.plan_state==='pending'&&!task.rollback_blocked)actions.appendChild(button('放弃此方案',guarded(async()=>{const result=await action('cancel-review',{id:task.uuid});await refresh();notice(result.message);}),'button quiet small'));
      if(task.layout==='legacy'&&(task.subject_id||task.bgm_id))actions.appendChild(button('预览条目目录迁移',guarded(async()=>{const plan=await action('layout',{id:task.uuid});adoptPlan(task,plan);})));card.appendChild(actions);list.appendChild(card);
    }
    const prev=button('上一页',()=>{state.page--;renderTaskRows(list,pager);}),next=button('下一页',()=>{state.page++;renderTaskRows(list,pager);});prev.disabled=state.page===0;next.disabled=state.page>=pages-1;pager.append(el('span','',tasks.length+' 条 · '+(state.page+1)+' / '+pages+' 页'),prev,next);
  }
  function adoptPlan(task,plan){if(!plan||plan.state!=='pending')throw Error('没有可审核的方案，请先重新识别');state.selected=task;state.plan=plan;state.rows=JSON.parse(JSON.stringify(plan.draft_rows||plan.rows));state.checked=plan.review||null;state.dirty=!plan.review;state.rowPage=0;state.reviewQuery='';state.onlyAttention=false;state.expanded=new Set();state.screen='plan';render();}
  async function openPlan(task){const plan=await action('plan',{id:task.uuid});adoptPlan(task,plan);}
  function renderEdit(host){
    const task=state.selected;host.appendChild(button('← 返回整理任务',back,'button quiet'));const form=el('form','settings-card organizer-form');form.append(el('h3','','识别信息'),hint(task.path));const changes={};const fields=el('div','organizer-form-grid');
    for(const [key,title]of [['name','作品名称 / 搜索名'],['bgm_id','Bangumi 条目 ID'],['tmdb_id','TMDB ID'],['year','年份'],['season_id','TMDB 季号'],['subtitle_group','字幕组']]){const control=input(task[key]);control.oninput=()=>changes[key]=control.value||null;fields.appendChild(label(title,control));}
    for(const [key,title]of [['is_anime','动画类型'],['is_movie','电影类型']]){const control=select([['','自动'],['true','是'],['false','否']],task[key]===null||task[key]===undefined?'':String(task[key]));control.onchange=()=>changes[key]=control.value===''?null:control.value==='true';fields.appendChild(label(title,control));}
    for(const [key,title]of [['use_ai','AI 辅助识别'],['skip_search','仅使用给定信息']]){const control=input('', 'checkbox');control.checked=Boolean(task[key]);control.onchange=()=>changes[key]=control.checked;fields.appendChild(label(title,control));}form.appendChild(fields);
    if(task.bangumi_candidates?.length){const candidates=el('div','organizer-candidates');candidates.appendChild(el('h4','','匹配候选'));for(const item of task.bangumi_candidates){const id=item.id||item.subject_id;const pick=button((item.name_cn||item.name||id)+' · BGM '+id,()=>{changes.bgm_id=String(id);fields.querySelectorAll('input')[1].value=id;});candidates.appendChild(pick);}form.appendChild(candidates);}
    const actions=controls();actions.append(button('保存识别信息',guarded(async()=>{await action('save-task',{id:task.uuid,changes});await load();back();notice('识别信息已保存');})),button('生成新方案',guarded(async()=>{await action('retry',{id:task.uuid,changes});await load();const updated=state.tasks.find(t=>t.uuid===task.uuid);if(updated?.plan_state==='pending')await openPlan(updated);else{back();notice('识别结果已更新，请查看任务提示');}}),'button primary'));form.appendChild(actions);form.onsubmit=e=>e.preventDefault();host.appendChild(form);
  }
  function renderPlan(host){
    const plan=state.plan,task=state.selected;host.appendChild(button('← 返回整理任务',back,'button quiet'));
    const items=reviewRows(plan,state.rows,state.checked),attention=items.filter(item=>item.attention).length;
    const heading=el('section','plan-review-heading');heading.append(el('h3','',(task.name||'文件方案')+' · '+(plan.context.layout_migration?'目录迁移':plan.mode+'入库')),hint(state.rows.length+' 个视频 · '+attention+' 个需核对 · '+state.rows.filter(row=>row.skip).length+' 个跳过。需核对的视频排在前面；展开行可调整。'));
    host.appendChild(heading);
    const actions=controls();actions.classList.add('plan-review-actions');
    const feedback=el('span','plan-check-feedback',state.dirty?'调整后请更新检查，当前目标为上次预览':state.checked?.issues?.length?'检查发现问题，请处理标记行':'检查通过，核对后可执行');feedback.dataset.reviewFeedback='';
    const check=button('更新检查',guarded(async()=>{check.disabled=true;try{const snapshot=JSON.stringify(state.rows);const checked=await action('check',{id:task.uuid,revision:plan.revision,rows:JSON.parse(snapshot)});if(snapshot!==JSON.stringify(state.rows)){invalid();notice('检查期间方案已变化，请重新检查');return;}state.checked=checked;state.dirty=false;render();}finally{check.disabled=false;}}));
    const execute=button('执行入库',guarded(async()=>{if(state.dirty||!state.checked||state.checked.issues.length)throw Error('请先更新检查');execute.disabled=true;await action('execute',{id:task.uuid,revision:plan.revision,rows:state.rows,token:state.checked.token});await load();back();notice('整理完成，媒体库已更新');}),'button primary');execute.dataset.execute='';execute.disabled=state.dirty||!state.checked||Boolean(state.checked.issues.length);const cancel=button(plan.can_rollback?'取消本次重新识别':'放弃此方案',guarded(async()=>{cancel.disabled=true;execute.disabled=true;check.disabled=true;try{const result=await action('cancel-review',{id:task.uuid,revision:plan.revision});await load();back();notice(result.message);}finally{cancel.disabled=false;check.disabled=false;execute.disabled=state.dirty||!state.checked||Boolean(state.checked.issues.length);}}),'button quiet');
    cancel.disabled=Boolean(plan.rollback_blocked);actions.append(feedback,cancel,check,execute);host.appendChild(actions);
    if(plan.rollback_blocked)host.appendChild(hint('识别后的操作记录已变化，不能通过取消识别回退，请先核对执行记录。'));else if(!plan.can_rollback)host.appendChild(hint('此方案没有重新识别前的快照：可放弃方案并保留现有文件，但无法完整恢复更早的识别信息。'));
    if(plan.context.layout==='bangumi'){const line=controls(),id=input('');id.placeholder='需要加入合集的其他 Bangumi ID';line.append(id,button('载入关联条目',guarded(async()=>{const context=await action('add-subject',{id:task.uuid,revision:plan.revision,subject_id:id.value});state.plan=context;invalid();render();})));host.appendChild(line);}
    const bar=controls(),search=input(state.reviewQuery||'');search.placeholder='筛选源文件、目标或问题原因';search.setAttribute('aria-label','筛选方案文件');const only=input('','checkbox');only.checked=Boolean(state.onlyAttention);const rowsHost=el('div','plan-review-list'),pager=controls();
    function drawRows(){const query=(state.reviewQuery||'').toLocaleLowerCase();const filtered=items.filter(item=>(!state.onlyAttention||item.attention)&&[item.row.source,item.target,...item.reasons].some(value=>String(value).toLocaleLowerCase().includes(query)));const pages=Math.max(1,Math.ceil(filtered.length/40));state.rowPage=Math.min(state.rowPage||0,pages-1);rowsHost.replaceChildren();pager.replaceChildren();for(const item of filtered.slice(state.rowPage*40,(state.rowPage+1)*40))renderPlanRow(rowsHost,item.row,plan,item);if(!filtered.length)rowsHost.appendChild(hint('没有符合条件的视频'));const prev=button('上一页',()=>{state.rowPage--;drawRows();}),next=button('下一页',()=>{state.rowPage++;drawRows();});prev.disabled=!state.rowPage;next.disabled=state.rowPage>=pages-1;pager.append(el('span','',filtered.length+' 个视频 · '+(state.rowPage+1)+' / '+pages+' 页'),prev,next);}
    search.oninput=()=>{state.reviewQuery=search.value;state.rowPage=0;drawRows();};only.onchange=()=>{state.onlyAttention=only.checked;state.rowPage=0;drawRows();};bar.append(search,label('只看需核对',only));host.append(bar,rowsHost,pager);drawRows();
    const companions=(state.checked?.preview||[]).filter(item=>!state.rows.some(row=>row.source===item.source));if(companions.length){const section=el('details','plan-companions');section.appendChild(el('summary','',companions.length+' 个关联字幕 / 音轨映射'));const table=el('table','organizer-preview');for(const item of companions){const tr=el('tr');for(const value of [item.source_label,item.target_label,item.action])tr.appendChild(el('td','',value));table.appendChild(tr);}section.appendChild(table);host.appendChild(section);}
  }
  function renderPlanRow(host,row,plan,item){
    const card=el('details','plan-review-row'+(item.attention?' needs-attention':'')+(row.skip?' skipped':''));card.open=state.expanded.has(row.source);card.ontoggle=()=>{if(!card.isConnected)return;if(card.open){state.expanded.add(row.source);mountEditor();}else state.expanded.delete(row.source);};
    const summary=el('summary','plan-review-summary'),source=el('span','plan-row-source',require('path').basename(row.source)),target=el('span','plan-row-target',row.skip?'保持原样':item.targetLabel);source.title=row.source;target.title=item.target||item.reasons.join('\n');summary.append(source,el('span','plan-row-arrow','→'),target,el('span','plan-row-status',item.status));card.appendChild(summary);if(item.attention){const warning=el('small','plan-row-problem',item.reasons[0]);warning.title=item.reasons.join('\n');summary.appendChild(warning);}
    function mountEditor(){if(card.dataset.loaded)return;card.dataset.loaded='true';
    const body=el('div','plan-row-editor');for(const reason of item.reasons)body.appendChild(el('p','plan-row-warning',reason));body.append(hint('源文件：'+row.source),hint('最终目标：'+(item.target||'待确认')));const grid=el('div','organizer-form-grid');
    if(plan.context.layout==='bangumi'){
      const subjects={[String(plan.context.subject_id)]:plan.context,...plan.context.subjects};const sid=String(row.subject_id||plan.context.subject_id);const subject=select(Object.entries(subjects).map(([id,s])=>[id,s.name+' · '+id]),sid);subject.onchange=()=>{row.subject_id=subject.value;row.episode_id=null;row.category='unresolved';invalid();render();};grid.appendChild(label('归属作品',subject));
      const category=select([['episode','匹配章节'],['extra','附加资源'],['unresolved','待确认']],row.category);category.onchange=()=>{row.category=category.value;invalid();};grid.appendChild(label('资源类型',category));
      const types={0:'本篇',1:'特别篇',2:'OP',3:'ED',4:'预告',5:'MAD',6:'其他'};const episodes=select([['','请选择章节'],...(subjects[sid]?.episodes||[]).map(ep=>[String(ep.id),(types[ep.type]||'其他')+' '+ep.sort+' · '+ep.name])],String(row.episode_id||''));episodes.onchange=()=>{row.episode_id=episodes.value||null;if(row.episode_id){row.category='episode';category.value='episode';}invalid();};grid.appendChild(label('Bangumi 章节',episodes));
    }else for(const [key,title]of [['season','季号'],['episode','集号']]){const control=input(row[key],'number');control.min=key==='season'?0:1;control.oninput=()=>{row[key]=control.value===''?null:Number(control.value);invalid();};grid.appendChild(label(title,control));}
    for(const [key,title]of [['version','版本标识'],['filename','自定义标题（自动补字幕组和扩展名）']]){const control=input(row[key]);control.oninput=()=>{row[key]=control.value;invalid();};grid.appendChild(label(title,control));}const skip=input('','checkbox');skip.checked=Boolean(row.skip);skip.onchange=()=>{row.skip=skip.checked;invalid();};grid.appendChild(label('跳过视频及关联字幕，保留已有输出',skip));body.appendChild(grid);card.appendChild(body);}
    if(card.open)mountEditor();host.appendChild(card);
  }
  function renderConfig(host){
    const config=state.config,form=el('form','settings-card organizer-form'),changes={};form.onsubmit=e=>e.preventDefault();form.appendChild(el('h3','','整理设置'));const groups=[['媒体库路径',[['anime_path','动画剧集目录'],['anime_movie_path','动画电影目录'],['bangumi_path','其他剧集目录'],['movie_path','其他电影目录']]],['识别与执行',[['mode','文件处理方式'],['api_key','TMDB API 密钥'],['episode_offset','跨季集数偏移']]],['AI 识别',[['ai_enabled','启用 AI'],['ai_provider','AI 提供商'],['ai_confidence_threshold','置信度阈值'],['ai_api_key','OpenAI 兼容 API 密钥'],['ai_base_url','API 地址'],['ai_model','模型'],['openai_output_format','输出格式'],['gemini_api_key','Gemini API 密钥'],['gemini_base_url','Gemini API 地址'],['gemini_model','Gemini 模型'],['ai_auto_save','保存 AI 分析']]]];
    for(const [title,fields]of groups){form.appendChild(el('h4','',title));const grid=el('div','organizer-form-grid');for(const [key,text]of fields){let control;
      const options={mode:[['链接','硬链接'],['复制','复制'],['剪切','移动']],ai_provider:[['openai','OpenAI 兼容'],['gemini','Gemini']],ai_confidence_threshold:[['High','High'],['Medium','Medium'],['Low','Low']],openai_output_format:[['function_calling','Function Calling'],['json_object','JSON Object'],['structured_output','Structured Output'],['text','Text']]};
      if(options[key])control=select(options[key],config[key]);else if(typeof config[key]==='boolean'){control=input('','checkbox');control.checked=config[key];}else control=input(config[key],key.includes('api_key')?'password':typeof config[key]==='number'?'number':'text');control.onchange=()=>{changes[key]=control.type==='checkbox'?control.checked:control.type==='number'?Number(control.value):control.value;};grid.appendChild(label(text,control));}form.appendChild(grid);}
    form.append(hint('设置对后续识别生效，已生成的方案保留创建时的处理方式。'),button('保存整理设置',guarded(async()=>{await action('save-config',{changes});Object.assign(config,changes);notice('整理设置已保存');}),'button primary'));host.appendChild(form);
  }
  return {render,refresh};
}
module.exports={create};
