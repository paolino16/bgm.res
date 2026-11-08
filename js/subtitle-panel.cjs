'use strict';
const path=require('path');
const {normalized}=require('./rename-binding-core.cjs');
const {summaryLabel}=require('./subtitle-index.cjs');
const versions=require('./subtitle-versions.cjs');
function fileStatus(file){if(['error','unavailable'].includes(file.state))return 'error';if(file.internal?.length||file.external?.length||file.manual==='burned')return 'present';if(file.manual==='none')return 'missing';return 'unknown';}
function create({ipc,node,button,notice,refresh}){
  const pendingFiles=new Map();
  const {pagination:pageControls}=require('./pagination.cjs');
  const states=new Map();
  const el=(tag,cls,text)=>node(tag,cls,text);
  const field=(name,input)=>{const label=el('label','organizer-field');label.append(el('span','',name),input);return label;};
  function input(value,type='text'){const item=el('input');item.type=type;item.value=value??'';return item;}
  const bar=()=>el('div','organizer-actions');
  const hint=text=>el('p','inline-note',text);
  async function action(name,body){const response=await ipc.invoke('organizer:action',{action:name,body});if(response.cancelled)return response;const {job_id}=response;let polls=0;for(;;){const job=await ipc.invoke('organizer:job',job_id);if(job.state==='failed')throw Error(job.error);if(job.state==='completed')return job.result;await new Promise(resolve=>setTimeout(resolve,Math.min(500,100*2**polls++)));}}
  function mount(work,host){
    let state=states.get(work.id);if(!state){state={folder:'',files:[],offset:0,plan:null,report:null,busy:false,filePage:0,subPage:0,query:'',filter:'all',expanded:new Set(),importExpanded:new Set(),loading:false};states.set(work.id,state);}
    const selected=pendingFiles.get(work.id);
    if(selected){state.files=[...selected];state.folder='';state.offset=0;state.plan=null;state.subPage=0;pendingFiles.delete(work.id);}
    state.jumpDrafts??={files:{},preview:{}};
    const safe=fn=>async()=>{try{await fn();}catch(error){notice(error.message);}};
    const {preserveInteraction}=require('./ui-regions.cjs');
    let mounted=false,summaryText,scanControl,statusHost,importPreview,syncImport,drawFiles,lastReport,lastFileLock,versionHost,importCard,inbox;
    async function loadVersions(){
      state.context=await ipc.invoke('subtitles:context',work.id);
      if(state.context.tasks.length)state.inventory=await action('subtitle-versions',{ids:state.context.tasks.map(task=>task.id),videos:state.context.tasks.flatMap(task=>task.files)});
    }
    async function reload(){state.report=await ipc.invoke('subtitles:details',work.id);await loadVersions();await inbox?.refresh();await refresh();state.render();}
    function render(){if(!host.isConnected)return;
      if(!mounted){mounted=true;
        const overview=el('section','subtitle-overview'),info=el('div','subtitle-overview-copy');
        summaryText=el('p','subtitle-summary');info.append(el('h3','','字幕'),summaryText);
        scanControl=button('检测本剧字幕',safe(async()=>{state.scanning=true;state.error='';state.render();try{state.report=await ipc.invoke('subtitles:scan',{id:work.id});await loadVersions();await refresh();}catch(error){state.error=error.message;throw error;}finally{state.scanning=false;state.render();}}),'button quiet');
        const utilities=bar();utilities.append(button('添加字幕版本',()=>{state.importMode='add';state.replaceGroup=undefined;importCard.open=true;state.render();importCard.scrollIntoView?.({block:'nearest'});}),scanControl);
        overview.append(info,utilities);host.appendChild(overview);
        statusHost=el('div');host.appendChild(statusHost);
        versionHost=el('div','subtitle-version-list');host.appendChild(versionHost);
        inbox=require('./subtitle-inbox-ui.cjs').mount({ipc,node,button,notice,host,work,onSelect:async files=>{state.files=files;state.folder='';state.plan=null;importCard.open=true;state.render();await state.preview();}});
        renderImport();renderFiles();
      }
      summaryText.textContent=state.loading?'正在读取已有检测结果…':summaryLabel(state.report?.summary||work.SubtitleSummary);
      scanControl.textContent=state.scanning?'正在检测…':'检测本剧字幕';scanControl.disabled=Boolean(state.scanning||state.busy||state.loading);
      statusHost.replaceChildren();
      if(state.error){const error=el('p','subtitle-feedback error','读取或检测失败：'+state.error+'。可重新点击“检测本剧字幕”。');error.setAttribute('role','alert');statusHost.appendChild(error);}
      if(state.scanning){const status=el('p','subtitle-feedback','正在后台读取本剧字幕轨道，可继续浏览或切换页面。');status.setAttribute('role','status');statusHost.appendChild(status);}
      drawVersions();
      syncImport();preserveInteraction(importPreview,()=>{importPreview.replaceChildren();renderPreview();});
      const lock=Boolean(state.scanning||state.busy||state.marking);
      if(lastReport!==state.report||lastFileLock!==lock){lastReport=state.report;lastFileLock=lock;drawFiles?.();}
    }
    function drawVersions(){
      versionHost.replaceChildren();
      const groups=state.inventory?.groups||versions.groups(state.report),total=state.report?.files?.length||0;
      if(state.inventory?.pending)versionHost.append(hint('有未完成的字幕操作。'),button('恢复字幕操作',safe(async()=>{const result=await action('subtitle-recover',{});if(result.warning)notice(result.warning);await reload();})));
      for(const group of groups){
        const section=el('section','subtitle-version'),line=el('div','subtitle-version-line'),copy=el('div','subtitle-version-copy');
        copy.append(el('strong','',versions.label(group.suffix)),el('small','',versions.coverage(group.videos,state.context,state.report)+' · '+group.formats.join(' / ')));
        const controls=bar(),files=el('details','subtitle-version-files');files.append(el('summary','','文件明细 · '+group.files.length));
        for(const file of group.files){const row=el('div','subtitle-version-file');row.append(el('span','',path.basename(file.path)),el('small','',path.basename(file.video)));row.title=file.path;files.append(row);}
        controls.append(button('查看字幕文件',()=>{files.open=!files.open;}));
        const replace=button('替换字幕版本',()=>{state.replaceGroup=group.id;state.importMode='replace';state.files=[];state.folder='';state.plan=null;importCard.open=true;state.render();importCard.scrollIntoView?.({block:'nearest'});});
        const remove=button('移除字幕版本',safe(async()=>{state.busy=true;state.render();try{const result=await action('subtitle-manage',{ids:state.context.tasks.map(task=>task.id),videos:state.inventory.videos,mode:'remove',group:group.id,token:group.token});if(result.cancelled)return;if(result.warning)notice(result.warning);await reload();}finally{state.busy=false;state.render();}}));
        replace.disabled=remove.disabled=Boolean(state.busy||state.scanning||!group.token||state.inventory?.pending);controls.append(replace,remove);
        line.append(copy,controls);section.append(line,files);versionHost.append(section);
      }
      const internal=(state.report?.files||[]).filter(file=>file.internal?.length);
      if(internal.length){const line=el('div','subtitle-version-line subtitle-internal');line.append(el('strong','','内封字幕'),el('small','',versions.coverage(internal.map(file=>file.path),state.context,state.report)+' · 随视频保留'));versionHost.append(line);}
      if(!groups.length&&!internal.length)versionHost.append(hint(state.loading?'正在读取字幕…':'暂无外挂字幕版本，可从右上角添加。'));
    }
    function renderImport(){
      const card=el('details','subtitle-import subtitle-import-compact');importCard=card;card.open=Boolean(selected||state.files.length||state.folder||state.importMode==='replace');card.append(el('summary','','导入字幕'));
      const sourceLabel=state.files.length>1?'已选择 '+state.files.length+' 个字幕文件':state.files[0]||state.folder;
      const replacementHint=hint('');card.append(replacementHint);
      const controls=bar(),folder=input(sourceLabel),offset=input(state.offset,'number');controls.className+=' subtitle-source-controls';folder.placeholder='字幕文件、压缩包或文件夹';folder.title=state.files.join('\n');folder.readOnly=state.files.length>1;folder.disabled=state.busy;offset.disabled=state.busy;folder.setAttribute('aria-label','字幕文件或目录');offset.setAttribute('aria-label','字幕集数偏移');
      function invalidate(){state.plan=null;const execute=host.querySelector('[data-subtitle-execute]');if(execute)execute.disabled=true;const status=host.querySelector('[data-subtitle-count]');if(status)status.textContent='字幕来源或集数偏移已变化，请重新匹配预览。';preview.disabled=state.busy||(!state.files.length&&!state.folder.trim());}
      folder.oninput=()=>{state.files=[];state.folder=folder.value;invalidate();};offset.oninput=()=>{state.offset=Number(offset.value);invalidate();};
      const choose=button('选择目录',safe(async()=>{const paths=await ipc.invoke('organizer:pick','subtitle-folder');if(paths.length){state.files=[];state.folder=paths[0];invalidate();state.render();}}));
      const chooseFiles=button('选择字幕文件',safe(async()=>{const paths=await ipc.invoke('organizer:pick','subtitle-files');if(paths.length){state.files=[...new Set(paths)];state.folder='';invalidate();state.render();}}));choose.disabled=chooseFiles.disabled=state.busy;
      async function extractArchives(paths){
        state.busy=true;state.render();const files=[];
        try{for(const archive of paths){try{const result=await ipc.invoke('subtitle-sources:local',{archive,workId:work.id,workName:work.Name});files.push(...result.files);if(result.warning)notice(result.warning);}catch(error){notice(path.basename(archive)+'：'+error.message);}}if(files.length){state.files=[...new Set(files)];state.folder='';invalidate();}await inbox?.refresh();}
        finally{state.busy=false;state.render();}
      }
      const chooseArchives=button('选择字幕压缩包',safe(async()=>{const paths=await ipc.invoke('organizer:pick','subtitle-archives');if(paths.length)await extractArchives(paths);}));chooseArchives.disabled=state.busy;
      const preview=button('匹配预览',safe(async()=>{state.busy=true;state.render();try{
        if(!state.files.length&&/\.(zip|7z|rar)$/i.test(state.folder.trim())){await extractArchives([state.folder.trim()]);if(!state.files.length)return;state.busy=true;state.render();}
        const context=await ipc.invoke('subtitles:context',work.id);if(!context.tasks.length)throw Error('此作品没有可用整理记录，暂不能自动导入字幕');
        const ownership=new Map();for(const task of context.tasks)for(const file of task.files)if(!ownership.has(normalized(file)))ownership.set(normalized(file),{path:file,task:task.id});
        const plan=await action('subtitle-preview',{ids:context.tasks.map(task=>task.id),chapters:context.chapters,folder:state.folder,files:state.files.length?state.files:undefined,offset:state.offset});
        const available=new Set(plan.videos.map(normalized));for(const key of ownership.keys())if(!available.has(key))ownership.delete(key);
        state.plan={ownership,rows:plan.rows.map(row=>({...row,detectedSuffix:row.suffix||'',videos:[...new Set((row.videos??(row.video?[row.video]:[])).filter(file=>ownership.has(normalized(file))).map(file=>ownership.get(normalized(file)).path))],reason:row.reason}))};state.subPage=0;state.batchScope='all';state.showMatches=undefined;
      }finally{state.busy=false;state.render();}}),'button primary');preview.disabled=state.busy||(!state.files.length&&!state.folder.trim());
      const offsetField=field('集数偏移',offset);offsetField.className+=' subtitle-offset-field';controls.append(field('字幕来源',folder),chooseFiles,chooseArchives,choose,offsetField,preview);card.appendChild(controls);if(state.busy)card.appendChild(hint('正在处理字幕，请稍候…'));host.appendChild(card);
      state.preview=()=>preview.onclick();
      importPreview=el('div','subtitle-import-preview');card.appendChild(importPreview);
      syncImport=()=>{
        const value=state.files.length>1?'已选择 '+state.files.length+' 个字幕文件':state.files[0]||state.folder;
        if(folder.value!==value)folder.value=value;
        folder.title=state.files.join('\n');folder.readOnly=state.files.length>1;offset.value=state.offset;
        folder.disabled=offset.disabled=choose.disabled=chooseFiles.disabled=chooseArchives.disabled=Boolean(state.busy);
        const group=state.inventory?.groups.find(group=>group.id===state.replaceGroup);replacementHint.textContent=state.importMode==='replace'?'替换 '+(group?versions.label(group.suffix):'已有版本')+' · 选择字幕文件、压缩包或文件夹后预览':'';replacementHint.hidden=!replacementHint.textContent;
        preview.disabled=state.busy||(!state.files.length&&!state.folder.trim());
      };
    }
    function renderPreview(){
      if(!state.plan)return;const plan=state.plan;
      if(!plan.rows.length){importPreview.appendChild(hint('所选来源未找到支持的字幕文件'));return;}
      const resultHeading=el('div','section-heading subtitle-preview-heading');resultHeading.append(el('h3','','核对导入匹配'),el('small','',plan.rows.length+' 个字幕 · 目标为空的文件将跳过'));importPreview.appendChild(resultHeading);
      const batch=el('div','subtitle-batch-controls'),mode=el('select');mode.setAttribute('aria-label','导入方式');mode.add(new Option('新增版本','add'));mode.add(new Option('替换已有版本','replace'));mode.value=state.importMode||'add';mode.disabled=state.busy;
      mode.onchange=()=>{state.importMode=mode.value;state.render();};batch.append(field('方式',mode));
      if(mode.value==='replace'){
        const target=el('select');target.setAttribute('aria-label','替换的字幕版本');target.add(new Option('选择旧字幕版本','__none__'));
        for(const group of state.inventory?.groups||[])target.add(new Option(versions.label(group.suffix),group.id));target.value=state.replaceGroup??'__none__';target.disabled=state.busy;
        target.onchange=()=>{state.replaceGroup=target.value;state.render();};batch.append(field('旧版本',target));
      }
      const language=el('select');language.setAttribute('aria-label','批量字幕语言');for(const [value,label]of [['keep','保留识别语言'],['','自定义'],['chs','简中'],['cht','繁中'],['jpsc','简日'],['jptc','繁日'],['en','英语']])language.add(new Option(label,value));language.value=state.batchLanguage??'keep';language.onchange=()=>{state.batchLanguage=language.value;};
      const groupInput=input(state.batchGroup||'');groupInput.placeholder='字幕组或自定义后缀';groupInput.setAttribute('aria-label','批量字幕组');groupInput.oninput=()=>{state.batchGroup=groupInput.value;};
      const scopes=[...new Set(plan.rows.map(row=>row.detectedSuffix))];
      if(scopes.length>1){const scope=el('select');scope.setAttribute('aria-label','后缀应用范围');scope.add(new Option('全部字幕','all'));for(const value of scopes)scope.add(new Option(versions.label(value),'suffix:'+value));scope.value=state.batchScope||'all';scope.disabled=state.busy;scope.onchange=()=>{state.batchScope=scope.value;};batch.append(field('应用范围',scope));}
      const apply=button('应用字幕后缀',()=>{for(const row of plan.rows){if(state.batchScope&&state.batchScope!=='all'&&state.batchScope!=='suffix:'+row.detectedSuffix)continue;row.suffix=[language.value==='keep'?row.detectedSuffix:language.value,groupInput.value.trim()].filter(Boolean).join('.');}state.render();});
      language.disabled=groupInput.disabled=apply.disabled=state.busy;batch.append(field('语言',language),field('字幕组 / 后缀',groupInput),apply);importPreview.appendChild(batch);
      const matches=el('details','subtitle-match-details');matches.open=state.showMatches??plan.rows.some(row=>!row.videos.length);matches.ontoggle=()=>{state.showMatches=matches.open;};matches.append(el('summary','',plan.rows.filter(row=>row.videos.length).length+' 个文件已匹配 · '+plan.rows.filter(row=>!row.videos.length).length+' 个需确认 · 查看明细'));importPreview.appendChild(matches);
      for(const row of plan.rows.slice(state.subPage*20,(state.subPage+1)*20)){
        const section=el('details','subtitle-import-row');section.open=state.importExpanded.has(row.source)||!row.videos.length;section.ontoggle=()=>{if(section.open)state.importExpanded.add(row.source);else state.importExpanded.delete(row.source);};
        const heading=el('summary','subtitle-match-summary'),title=el('div','subtitle-row-title'),targetLabel=el('small','subtitle-match-target'),status=el('span');
        title.append(el('strong','',path.basename(row.source)),targetLabel);heading.append(title,status);section.appendChild(heading);
        function updateTargets(){targetLabel.textContent=row.videos.length?'已选 '+row.videos.length+' 个版本：'+row.videos.map(file=>path.basename(file)).join('、'):'未选择 · 默认跳过';status.textContent=row.videos.length?'已选择':'需确认';status.className='subtitle-status '+(row.videos.length?'present':'unknown');updateImportCount();}
        const body=el('div','subtitle-row-body');body.appendChild(hint(row.source));
        const targets=el('fieldset','subtitle-targets');targets.append(el('legend','','本剧的目标视频（可多选）'),hint('可同时勾选多个版本；不勾选则跳过这条字幕。'));
        const choices=el('div','subtitle-target-list'),candidates=new Set((row.candidates||[]).map(normalized));
        const values=[...plan.ownership.values()].sort((a,b)=>Number(candidates.has(normalized(b.path)))-Number(candidates.has(normalized(a.path))));
        for(const value of values){
          const label=el('label','subtitle-target-option'),check=input(value.path,'checkbox');check.dataset.subtitleTarget='';check.checked=row.videos.includes(value.path);check.disabled=state.busy;
          const description=el('span');description.append(el('span','',path.basename(value.path)),el('small','',path.dirname(value.path)));
          check.onchange=()=>{row.videos=check.checked?[...new Set([...row.videos,value.path])]:row.videos.filter(file=>file!==value.path);updateTargets();};label.append(check,description);choices.appendChild(label);
        }
        targets.appendChild(choices);body.appendChild(targets);
        const grid=el('div','organizer-form-grid'),suffix=input(row.suffix);suffix.disabled=state.busy;suffix.oninput=()=>{row.suffix=suffix.value;updateImportCount();};
        grid.append(field('字幕后缀（例如 chs 或 chs.字幕组）',suffix));body.append(grid,hint(row.reason));section.appendChild(body);matches.appendChild(section);updateTargets();
      }
      pagination(plan.rows.length,state.subPage,page=>{state.subPage=page;state.render();},matches,true);
      const execute=button('确认并导入字幕',safe(async()=>{
        if(!state.plan)throw Error('目录或偏移已变化，请重新预览');
        const rows=plan.rows.flatMap(row=>row.videos.map(video=>({source:row.source,video,suffix:row.suffix})));
        if(!rows.length)throw Error('请至少匹配一条字幕');
        state.busy=true;state.render();
        try{
          const group=state.inventory?.groups.find(group=>group.id===state.replaceGroup);
          const result=await action('subtitle-manage',{ids:[...new Set([...plan.ownership.values()].map(owner=>owner.task))],videos:[...plan.ownership.values()].map(owner=>owner.path),rows,
            mode:state.importMode||'add',group:group?.id,token:group?.token});
          state.plan=null;state.files=[];state.folder='';state.importMode='add';state.replaceGroup=undefined;
          await reload();notice('已导入 '+result.count+' 份字幕'+(result.warning?'；'+result.warning:''));
        }finally{state.busy=false;state.render();}
      }),'button primary');execute.dataset.subtitleExecute='';const footer=el('div','subtitle-import-footer'),count=el('span','');count.dataset.subtitleCount='';footer.append(count,execute);importPreview.appendChild(footer);updateImportCount();
    }
    function updateImportCount(){
      const plan=state.plan;if(!plan)return;
      const selected=plan.rows.filter(row=>row.videos.length).length,count=plan.rows.reduce((total,row)=>total+row.videos.length,0),execute=host.querySelector('[data-subtitle-execute]'),label=host.querySelector('[data-subtitle-count]');
      const group=state.inventory?.groups.find(group=>group.id===state.replaceGroup),mode=state.importMode||'add';
      const destinations=new Set(),existing=new Set((state.inventory?.groups||versions.groups(state.report)).flatMap(group=>group.files.map(file=>normalized(file.path))));
      const replaceable=new Set(mode==='replace'?(group?.files||[]).map(file=>normalized(file.path)):[]);
      let conflict=false,overwrite=false;
      for(const row of plan.rows)for(const video of row.videos){const suffix=String(row.suffix||'').replace(/^\./,'');const target=normalized(path.join(path.dirname(video),path.basename(video,path.extname(video))+(suffix?'.'+suffix:'')+path.extname(row.source).toLowerCase()));if(destinations.has(target))conflict=true;if(existing.has(target)&&!replaceable.has(target))overwrite=true;destinations.add(target);}
      const retained=group?.videos.filter(video=>!plan.rows.some(row=>row.videos.includes(video))).length||0;
      if(execute)execute.disabled=state.busy||!count||conflict||(mode==='replace'&&!group)||Boolean(state.inventory?.pending);
      if(label)label.textContent='将导入 '+count+' 份字幕（'+selected+' 个源文件） · 跳过 '+(plan.rows.length-selected)+' 个'+(conflict?' · 多个源文件写入同一目标，请修改后缀或跳过重复项':overwrite?' · 目标重名，点击“确认并导入字幕”将直接替换':mode==='replace'?' · 未匹配的 '+retained+' 个旧字幕视频保留':' · 新增版本，保留已有字幕');
      if(label)label.title='下载包有未处理字幕时保留；全部导入或明确放弃剩余文件后清理。手动选择的外部文件不会清理。';
    }
    function renderFiles(){
      const section=el('details','subtitle-results subtitle-detection-details');section.append(el('summary','','检测详情'));const heading=el('div','section-heading');heading.append(el('h3','','视频文件'),el('small','', '0 个版本'));section.appendChild(heading);
      const toolbar=el('div','subtitle-result-toolbar'),search=input(state.query);search.placeholder='搜索视频文件名或路径…';search.setAttribute('aria-label','搜索字幕检测结果');
      const filter=el('select');filter.setAttribute('aria-label','筛选字幕检测状态');for(const [value,text] of [['all','全部状态'],['present','有字幕'],['unknown','未检测 / 待确认'],['missing','已确认无字幕'],['error','检测异常 / 离线']])filter.add(new Option(text,value));filter.value=state.filter;
      const manual=el('select');manual.setAttribute('aria-label','全部视频的人工确认');
      for(const [value,text]of [['burned','画面内嵌字幕'],['none','没有字幕'],['','清除人工确认']])manual.add(new Option(text,value));manual.value='burned';
      const confirmAll=button('确认全部',safe(async()=>{state.marking=true;state.render();try{state.report=await ipc.invoke('subtitles:mark',{id:work.id,all:true,value:manual.value});await refresh();notice('已更新本作品全部视频的人工确认');}finally{state.marking=false;state.render();}}),'button quiet');
      confirmAll.title='应用到本作品全部视频，包含筛选外和其他分页的文件';
      const confirmation=el('div','subtitle-bulk-confirm');confirmation.append(field('人工确认',manual),confirmAll);
      toolbar.append(search,filter);section.append(toolbar,confirmation);const list=el('div','subtitle-file-list'),pager=el('div','subtitle-pagination');section.append(list,pager);host.appendChild(section);
      function draw(){preserveInteraction(list,()=>{
        const report=state.report||{files:[]};heading.children[1].textContent=(report.files||[]).length+' 个版本';
        manual.disabled=confirmAll.disabled=Boolean(state.loading||state.scanning||state.busy||state.marking||!report.files?.length);
        list.replaceChildren();pager.replaceChildren();
        const query=state.query.trim().toLocaleLowerCase(),files=(report.files||[]).filter(file=>(state.filter==='all'||fileStatus(file)===state.filter)&&(!query||file.path.toLocaleLowerCase().includes(query)));
        state.filePage=Math.min(state.filePage,Math.max(0,Math.ceil(files.length/20)-1));
        if(!files.length){const empty=el('div','subtitle-empty');empty.append(el('strong','',report.files?.length?'没有符合条件的视频':'暂无已登记的视频文件'),hint(report.files?.length?'试试其他关键词或字幕状态。':'先将视频整理入库，再检测字幕或导入外挂。'));list.appendChild(empty);}
        for(const file of files.slice(state.filePage*20,(state.filePage+1)*20)){
          const card=el('details','subtitle-file');card.open=state.expanded.has(file.path);card.ontoggle=()=>{if(card.open)state.expanded.add(file.path);else state.expanded.delete(file.path);};
          const stateName=fileStatus(file),title=el('div','subtitle-row-title');title.append(el('strong','',path.basename(file.path)),el('small','',file.label||'字幕未检测 / 未知'));
          const summary=el('summary','subtitle-file-summary');summary.append(title,el('span','subtitle-status '+stateName,{present:'有字幕',missing:'已确认无字幕',error:'需处理',unknown:'待确认'}[stateName]));card.appendChild(summary);
          const body=el('div','subtitle-row-body'),tracks=el('div','subtitle-tracks');
          for(const track of file.internal||[])tracks.appendChild(el('p','subtitle-track','内封 · '+[track.language||'语言未知',track.codec,track.title].filter(Boolean).join(' · ')));
          for(const external of file.external||[])tracks.appendChild(el('p','subtitle-track','外挂 · '+path.basename(external)));
          if(!file.internal?.length&&!file.external?.length)tracks.appendChild(hint(file.manual==='burned'?'已手动确认画面内嵌字幕。':file.manual==='none'?'已手动确认没有字幕。':'尚无可展示的字幕轨或外挂；可检测视频，或核对是否为画面内嵌。'));
          if(file.error){const error=el('p','subtitle-feedback error','检测信息：'+file.error);error.setAttribute('role','status');tracks.appendChild(error);}
          body.appendChild(tracks);const controls=el('div','subtitle-file-controls');controls.appendChild(button('打开所在目录',safe(()=>ipc.invoke('library:explorer',{id:work.id,path:file.path,reveal:true})),'button quiet small'));
          const location=el('p','subtitle-file-path',file.path);location.title=file.path;body.append(controls,location);card.appendChild(body);list.appendChild(card);
        }
        pagination(files.length,state.filePage,page=>{state.filePage=page;draw();},pager);
      });}
      search.oninput=()=>{state.query=search.value;state.filePage=0;draw();};filter.onchange=()=>{state.filter=filter.value;state.filePage=0;draw();};drawFiles=draw;draw();
    }
    function pagination(count,page,change,destination=host,isPreview=destination===importPreview){
      if(count<=20)return;
      destination.appendChild(pageControls({node:el,button,page:page+1,pages:Math.ceil(count/20),summary:count+' 条',
        draft:destination===importPreview?state.jumpDrafts.preview:state.jumpDrafts.files,
        contextKey:destination===importPreview?state.folder:JSON.stringify([state.query,state.filter]),
        label:isPreview?'字幕导入预览分页':'字幕文件分页',onChange:value=>change(value-1)}));
    }
    state.render=render;
    if(!state.loading&&!state.scanning&&!state.busy){state.loading=true;render();ipc.invoke('subtitles:details',work.id).then(async report=>{state.report=report;state.error='';await loadVersions();}).catch(error=>{state.error=error.message;notice(error.message);}).finally(()=>{state.loading=false;state.render();});}else render();
    if(selected)queueMicrotask(async()=>{if(host.isConnected){await state.preview?.();const viewport=host.closest?.('#content');if(host.isConnected&&state.plan&&viewport)viewport.scrollTop+=importPreview.getBoundingClientRect().top-viewport.getBoundingClientRect().top;}});

  }
  function prepare(work,files){
    if(states.get(work.id)?.busy)throw Error('字幕正在导入，请完成后再选择下载文件');
    if(!Array.isArray(files)||!files.length||files.some(file=>typeof file!=='string'||!file.trim()))throw Error('没有可用于匹配的字幕文件');
    pendingFiles.set(work.id,[...files]);
  }
  return {mount,prepare};
}
module.exports={create,fileStatus};
