'use strict';
const path=require('path');
const {normalized}=require('./rename-binding-core.cjs');
const {summaryLabel}=require('./subtitle-index.cjs');
function create({ipc,node,button,notice,refresh}){
  const states=new Map();
  const el=(tag,cls,text)=>node(tag,cls,text);
  const field=(name,input)=>{const label=el('label','organizer-field');label.append(el('span','',name),input);return label;};
  function input(value,type='text'){const item=el('input');item.type=type;item.value=value??'';return item;}
  const bar=()=>el('div','organizer-actions');
  const hint=text=>el('p','inline-note',text);
  async function action(name,body){const {job_id}=await ipc.invoke('organizer:action',{action:name,body});for(;;){const job=await ipc.invoke('organizer:job',job_id);if(job.state==='failed')throw Error(job.error);if(job.state==='completed')return job.result;await new Promise(resolve=>setTimeout(resolve,500));}}
  function mount(work,host){
    let state=states.get(work.id);if(!state){state={folder:'',offset:0,plan:null,report:null,busy:false,filePage:0,subPage:0};states.set(work.id,state);}
    const safe=fn=>async()=>{try{await fn();}catch(error){notice(error.message);}};
    function render(){if(!host.isConnected)return;host.replaceChildren();
      const overview=el('section','settings-card');overview.append(el('h3','','字幕状态'),hint(summaryLabel(state.report?.summary||work.SubtitleSummary)),hint('内封字幕读取视频轨道，外挂字幕匹配同名文件；“未检测到”不能排除画面内嵌字幕，也不代表一定缺字幕。有字幕不代表包含中文字幕。'));
      const scan=button(state.scanning?'检测中…':'检测本剧字幕',safe(async()=>{state.scanning=true;render();try{state.report=await ipc.invoke('subtitles:scan',{id:work.id});await refresh();}finally{state.scanning=false;render();}}),'button quiet');scan.disabled=Boolean(state.scanning);overview.appendChild(scan);host.appendChild(overview);
      renderImport();renderFiles();
    }
    function renderImport(){
      const card=el('section','settings-card');card.append(el('h3','','导入外挂字幕'),hint('选择字幕目录，预览后将字幕匹配到本剧的视频版本。未选择视频的字幕会跳过；已有同名字幕可能被替换。'));
      const controls=bar(),folder=input(state.folder),offset=input(state.offset,'number');folder.placeholder='选择或粘贴字幕目录';folder.setAttribute('aria-label','字幕目录');offset.setAttribute('aria-label','字幕集数偏移');
      function invalidate(){state.plan=null;const execute=host.querySelector('[data-subtitle-execute]');if(execute)execute.disabled=true;}
      folder.oninput=()=>{state.folder=folder.value;invalidate();};offset.oninput=()=>{state.offset=Number(offset.value);invalidate();};
      const choose=button('选择目录',safe(async()=>{const paths=await ipc.invoke('organizer:pick','folder');if(paths.length){state.folder=paths[0];invalidate();render();}}));
      const preview=button('匹配预览',safe(async()=>{state.busy=true;render();try{
        const context=await ipc.invoke('subtitles:context',work.id);if(!context.tasks.length)throw Error('此作品没有可用整理记录，暂不能自动导入字幕');
        const ownership=new Map();for(const task of context.tasks)for(const file of task.files)if(!ownership.has(normalized(file)))ownership.set(normalized(file),{path:file,task:task.id});
        const rows=new Map();for(const task of context.tasks){const plan=await action('subtitle-preview',{id:task.id,folder:state.folder,offset:state.offset});for(const row of plan.rows){const key=normalized(row.source);if(!rows.has(key))rows.set(key,{source:row.source,suffix:row.suffix,candidates:new Set()});const entry=rows.get(key);if(row.video&&ownership.has(normalized(row.video)))entry.candidates.add(ownership.get(normalized(row.video)).path);}}
        state.plan={ownership,rows:[...rows.values()].map(row=>({...row,video:row.candidates.size===1?[...row.candidates][0]:'',reason:row.candidates.size===1?'按集号匹配':row.candidates.size>1?'多个版本，请选择':'未匹配，请选择或跳过'}))};state.subPage=0;
      }finally{state.busy=false;render();}}),'button primary');preview.disabled=state.busy;
      controls.append(folder,choose,field('集数偏移',offset),preview);card.appendChild(controls);if(state.busy)card.appendChild(hint('正在处理字幕，请稍候…'));host.appendChild(card);
      if(!state.plan)return;const plan=state.plan;
      if(!plan.rows.length){host.appendChild(hint('此目录未找到支持的字幕文件'));return;}
      for(const row of plan.rows.slice(state.subPage*20,(state.subPage+1)*20)){
        const section=el('section','settings-card subtitle-import-row');section.append(el('strong','',path.basename(row.source)),hint(row.source));const grid=el('div','organizer-form-grid'),video=el('select');video.add(new Option('跳过',''));for(const value of plan.ownership.values())video.add(new Option(path.basename(value.path)+' · '+path.dirname(value.path),value.path));video.value=row.video;video.onchange=()=>row.video=video.value;const suffix=input(row.suffix);suffix.oninput=()=>row.suffix=suffix.value;grid.append(field('本剧的目标视频',video),field('字幕后缀（例如 chs 或 chs.字幕组）',suffix));section.append(grid,hint(row.reason));host.appendChild(section);
      }
      pagination(plan.rows.length,state.subPage,page=>{state.subPage=page;render();});
      const execute=button('确认并导入字幕',safe(async()=>{if(!state.plan)throw Error('目录或偏移已变化，请重新预览');const groups=new Map();for(const row of plan.rows){if(!row.video)continue;const owner=plan.ownership.get(normalized(row.video));if(!owner)throw Error('目标视频已变化，请重新预览');if(!groups.has(owner.task))groups.set(owner.task,[]);groups.get(owner.task).push({source:row.source,video:row.video,suffix:row.suffix});}if(!groups.size)throw Error('请至少匹配一条字幕');state.busy=true;render();let completed=0;
        try{for(const [id,rows]of groups){await action('subtitle-execute',{id,rows});for(const row of rows){const original=plan.rows.find(r=>r.source===row.source);if(original)original.video='';}completed+=rows.length;}state.plan=null;state.report=await ipc.invoke('subtitles:scan',{id:work.id});await refresh();notice('已导入 '+completed+' 个字幕');}catch(error){throw Error('已完成 '+completed+' 条；'+error.message);}finally{state.busy=false;render();}
      }),'button primary');execute.dataset.subtitleExecute='';execute.disabled=state.busy;host.appendChild(execute);
    }
    function renderFiles(){const report=state.report;if(!report)return;const heading=el('div','section-heading');heading.appendChild(el('h3','','逐文件检测结果'));host.appendChild(heading);const files=report.files||[];
      for(const file of files.slice(state.filePage*20,(state.filePage+1)*20)){const card=el('section','settings-card subtitle-file');card.append(el('strong','',path.basename(file.path)),hint(file.label),hint(file.path));for(const track of file.internal||[])card.appendChild(hint('内封：'+[track.language||'语言未知',track.codec,track.title].filter(Boolean).join(' · ')));for(const external of file.external||[])card.appendChild(hint('外挂：'+path.basename(external)));if(file.error)card.appendChild(hint('检测信息：'+file.error));
        const manual=el('select');for(const [value,title]of [['','未手动确认'],['burned','已确认画面内嵌字幕'],['none','已确认没有字幕']])manual.add(new Option(title,value));manual.value=file.manual||'';manual.disabled=state.scanning||file.state==='unavailable';manual.onchange=safe(async()=>{state.report=await ipc.invoke('subtitles:mark',{id:work.id,path:file.path,value:manual.value});await refresh();render();});card.appendChild(field('人工确认',manual));host.appendChild(card);
      }pagination(files.length,state.filePage,page=>{state.filePage=page;render();});
    }
    function pagination(count,page,change){if(count<=20)return;const row=bar(),pages=Math.ceil(count/20),prev=button('上一页',()=>change(page-1)),next=button('下一页',()=>change(page+1));prev.disabled=page===0;next.disabled=page>=pages-1;row.append(el('span','',count+' 条 · '+(page+1)+'/'+pages+' 页'),prev,next);host.appendChild(row);}
    render();if(!state.report&&!state.scanning){state.scanning=true;ipc.invoke('subtitles:scan',{id:work.id}).then(async report=>{state.report=report;await refresh();}).catch(error=>notice(error.message)).finally(()=>{state.scanning=false;render();});}else if(state.report&&!state.busy&&!state.scanning){ipc.invoke('subtitles:details',work.id).then(report=>{state.report=report;render();}).catch(error=>notice(error.message));}
  }
  return {mount};
}
module.exports={create};
