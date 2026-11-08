'use strict';
const {pagination}=require('./pagination.cjs');
const providers=require('./subtitle-result-providers.cjs');
const sources=Object.entries(providers).map(([id,provider])=>[id,provider.label]);
const freshPages=()=>({pages:new Map(),page:1,maxPage:1,lastPage:null,jump:{}});
function create({ipc,node,button,notice}){
  const states=new Map();
  const el=(tag,cls,text)=>node(tag,cls,text);
  const note=text=>el('p','inline-note',text);
  const key=(element,value)=>{element.setAttribute('data-subtitle-focus',value);return element;};
  const safe=fn=>async(...args)=>{try{await fn(...args);}catch(error){notice(error.message);}};
  function mount(work,host,{onSelect,onSettings,heading=true}){
    let state=states.get(work.id);
    if(!state){state={active:sources[0][0],query:work.Name||'',selected:new Set(Object.keys(providers)),shown:new Set(Object.keys(providers)),groups:new Map(sources.map(([source])=>[source,{...freshPages(),query:work.Name||'',submitted:'',generation:0,details:new Map(),scroll:new Map(),view:'results',focusId:'source:'+source}]))};states.set(work.id,state);}
    const root=el('section','subtitle-online subtitle-browser');host.appendChild(root);
    if(heading)root.appendChild(el('h3','','搜索字幕'));
    const searchBox=el('div'),form=el('form','subtitle-online-query'),query=el('input');
    query.type='search';query.value=state.query;query.maxLength=100;query.placeholder='输入作品名或别名';query.setAttribute('aria-label','搜索作品名');
    query.oninput=()=>{state.query=query.value;};
    const submit=button('搜索字幕',()=>{},'button primary small');submit.type='submit';
    form.append(query,submit);searchBox.appendChild(form);
    const choices=el('div','subtitle-online-filters');choices.setAttribute('role','group');choices.setAttribute('aria-label','搜索来源');
    for(const [id,name] of sources){
      const label=el('label'),check=el('input');check.type='checkbox';check.checked=state.selected.has(id);
      check.onchange=()=>{if(check.checked)state.selected.add(id);else state.selected.delete(id);submit.disabled=!state.selected.size;};
      label.append(check,el('span','',name));choices.appendChild(label);
    }
    submit.disabled=!state.selected.size;searchBox.appendChild(choices);root.appendChild(searchBox);
    const tabs=el('div','subtitle-source-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','字幕来源');root.appendChild(tabs);
    const panels=new Map(),controls=new Map();
    const mounted={root,onSelect};state.mounted=mounted;
    const current=()=>state.mounted===mounted&&root.isConnected;
    const viewport=()=>root.closest?.('#content');
    const screen=group=>group.view==='detail'?'detail:'+group.selected+':'+group.details.get(group.selected)?.page:'results:'+group.page;
    function remember(source){const group=state.groups.get(source);if(current()&&state.active===source&&viewport())group.scroll.set(screen(group),viewport().scrollTop);}
    function restore(source){const group=state.groups.get(source);if(current()&&state.active===source&&viewport())viewport().scrollTop=group.scroll.get(screen(group))||0;}
    function redraw(source,options){state.mounted?.panels?.get(source)?.render(options);}
    function clearWaiting(slot){if(slot.timer)clearTimeout(slot.timer);slot.timer=null;slot.waiting=null;}
    function cancelGroup(group){clearWaiting(group);for(const item of group.details.values()){clearWaiting(item);for(const file of item.files.values())clearWaiting(file);}}
    function schedule(source,group,slot,result,retry,attempt){
      slot.pending=false;slot.waiting=result.retryAt;slot.retry=()=>retry(0);
      const generation=group.generation;
      if(attempt<2&&current()&&state.active===source)slot.timer=setTimeout(()=>{
        slot.timer=null;
        if(generation===group.generation&&state.mounted?.root.isConnected&&state.active===source)retry(attempt+1);
        else redraw(source);
      },Math.max(100,result.retryAt-Date.now()));
    }
    function selectSource(source,focus=false){
      if(!current())return;remember(state.active);state.active=source;
      for(const [id,control]of controls){control.setAttribute('aria-selected',String(id===source));control.tabIndex=id===source?0:-1;control.classList.toggle('active',id===source);panels.get(id).panel.hidden=id!==source;}
      redraw(source);restore(source);if(focus)controls.get(source).focus({preventScroll:true});
    }
    function storePage(slot,page,result){slot.pages.set(page,result);slot.page=page;slot.maxPage=Math.max(slot.maxPage,page,result.next||page);if(!result.next)slot.lastPage=page;}
    async function loadSearch(source,page=1,attempt=0){
      const group=state.groups.get(source),generation=group.generation;
      if(group.pending)return;
      clearWaiting(group);group.pending=true;group.error='';group.retry=()=>loadSearch(source,page);redraw(source);
      try{
        const result=await ipc.invoke('subtitle-sources:search',{source,query:group.submitted,cursor:page});
        if(generation!==group.generation)return;
        if(result.waiting)schedule(source,group,group,result,n=>loadSearch(source,page,n),attempt);
        else{if(!Array.isArray(result.rows))throw Error('来源未返回有效的搜索列表');storePage(group,page,result);group.view='results';group.selected=null;redraw(source);restore(source);}
      }catch(error){if(generation===group.generation)group.error=error.message;}
      finally{if(generation===group.generation){group.pending=false;redraw(source);}}
    }
    function goPage(source,page){
      const group=state.groups.get(source);if(group.pending||group.waiting)return;remember(source);
      if(group.pages.has(page)){group.page=page;redraw(source);restore(source);}else loadSearch(source,page);
    }
    async function loadDetail(source,row,item,page=1,attempt=0){
      const group=state.groups.get(source),generation=group.generation;
      if(item.pending)return;clearWaiting(item);item.pending=true;item.error='';item.retry=()=>loadDetail(source,row,item,page);redraw(source);
      try{
        const result=await ipc.invoke('subtitle-sources:detail',{source,id:row.id,cursor:page});
        if(generation!==group.generation)return;
        if(result.waiting)schedule(source,group,item,result,n=>loadDetail(source,row,item,page,n),attempt);
        else{storePage(item,page,{...result,posts:(result.posts||[]).filter(post=>post.files?.length)});redraw(source);restore(source);}
      }catch(error){if(generation===group.generation)item.error=error.message;}
      finally{if(generation===group.generation){item.pending=false;redraw(source);}}
    }
    async function download(source,row,post,file,slot,attempt=0){
      const group=state.groups.get(source),generation=group.generation;
      if(slot.pending)return;clearWaiting(slot);slot.pending=true;slot.error='';slot.retry=()=>download(source,row,post,file,slot);redraw(source);
      try{
        const result=await ipc.invoke('subtitle-sources:download',{source,id:row.id,postId:post.id,fileId:file.id,workId:work.id==='standalone'?null:work.id,workName:work.Name});
        if(generation!==group.generation)return;
        if(result.waiting)schedule(source,group,slot,result,n=>download(source,row,post,file,slot,n),attempt);else slot.download=result;
      }catch(error){if(generation===group.generation)slot.error=error.message;}
      finally{if(generation===group.generation){slot.pending=false;redraw(source);}}
    }
    async function downloadSelection(source,row,post,item,batch){
      if(batch.pending)return;
      const generation=state.groups.get(source).generation,selected=post.files.filter(file=>batch.selected.has(file.id));
      if(!selected.length)return;
      batch.pending=true;redraw(source);
      try{
        for(const file of selected){
          if(generation!==state.groups.get(source).generation)break;
          const slot=item.files.get(post.id+':'+file.id);
          if(slot.pending||slot.waiting)break;
          if(!slot.download)await download(source,row,post,file,slot);
          if(slot.error||slot.waiting)break;
        }
      }finally{batch.pending=false;redraw(source);}
    }
    function status(source,slot,host){
      if(slot.pending){const p=note('正在加载，请稍候…');p.setAttribute('role','status');host.appendChild(p);}
      if(slot.error){const p=el('p','subtitle-feedback error',slot.error);p.setAttribute('role','alert');host.append(p,key(button('重试',safe(slot.retry)),slot.focusId+':retry'));}
      if(slot.waiting){
        const p=note('伪射手额度暂时用尽。'+(slot.timer?'预计 '+new Date(slot.waiting).toLocaleTimeString('zh-CN',{hour12:false})+' 自动重试；最多自动重试两次。':'自动重试已暂停，可稍后手动重试。'));p.setAttribute('role','status');
        host.append(p,key(button('手动重试',safe(slot.retry)),slot.focusId+':retry'));
        if(slot.timer)host.appendChild(key(button('取消等待',()=>{clearWaiting(slot);slot.error='已取消自动重试';redraw(source);}),slot.focusId+':cancel'));
      }
    }
    function open(url,label='查看原网页'){return key(button(label,safe(()=>ipc.invoke('subtitle-sources:open',url)),'button quiet small'),'open:'+url+':'+label);}
    function pager(source,slot,label,change){
      const busy=Boolean(slot.pending||slot.waiting),pages=slot.lastPage||slot.maxPage;
      const nav=pagination({node:el,button,page:slot.page,pages,
        hasMore:slot.lastPage==null&&Boolean(slot.pages.get(slot.page)?.next),busy:Boolean(slot.pending||slot.waiting),
        nextDisabled:!slot.pages.get(slot.page)?.next,label,summary:'本页 '+(slot.pages.get(slot.page)?.rows?.length??slot.pages.get(slot.page)?.posts?.length??0)+' 条',
        draft:slot.jump,contextKey:state.groups.get(source).submitted,onChange:page=>{if(!busy&&Number.isInteger(page)&&page>=1&&page<=pages&&page!==slot.page)return change(page);}});
      for(const control of nav.querySelectorAll('button,input')){
        key(control,slot.focusId+':pager:'+label+':'+(control.getAttribute('aria-label')||control.textContent));
        const blocked=control.disabled;control.disabled=false;
        if(control.tagName==='INPUT')control.readOnly=busy;
        else{control.setAttribute('aria-disabled',String(Boolean(blocked)));const click=control.onclick;control.onclick=event=>{if(blocked){event.preventDefault();return;}return click?.(event);};}
      }
      return nav;
    }
    function showResults(source,focus=true){const group=state.groups.get(source);remember(source);group.view='results';redraw(source,{focus:focus?group.listFocus:null});restore(source);}
    function openDetail(source,row){
      const group=state.groups.get(source);if(group.pending||group.waiting)return;remember(source);group.listFocus=source+':'+row.id+':title';
      let item=group.details.get(row.id);
      if(!item){item={...freshPages(),row,files:new Map(),bodyOpen:new Map(),singleFilesOpen:new Map(),batches:new Map(),linksOpen:new Map(),focusId:source+':'+row.id};group.details.set(row.id,item);}
      group.selected=row.id;group.view='detail';redraw(source,{focus:'detail-back:'+source});restore(source);
      if(!item.pages.size&&!item.pending&&!item.waiting)loadDetail(source,row,item);
    }
    function drawPost(source,row,post,item,host){
      const section=el('section','subtitle-online-post');section.dataset.postId=post.id;
      const heading=el('div','subtitle-online-post-heading');heading.append(el('span','',post.author?'发帖人：'+post.author:'发帖人：未注明'),el('time','',post.date||'时间未注明'));section.appendChild(heading);
      const body=el('details','subtitle-online-body'),summary=key(el('summary','','说明'),item.focusId+':body:'+post.id);
      body.open=item.bodyOpen.get(post.id)!==false;body.ontoggle=()=>item.bodyOpen.set(post.id,body.open);
      const description=el('div','subtitle-online-description');
      if(post.bodyNodes?.length)require('./subtitle-rich-text.cjs').render(description,post.bodyNodes);
      if(!description.textContent.trim()){description.classList.remove('subtitle-rich-text');description.textContent=post.body||'未提供正文说明。';}
      body.append(summary,description);section.appendChild(body);
      const files=el('div','subtitle-post-files'),packages=el('div','subtitle-package-files');
      const singles=source==='assrt'?post.files.filter(file=>file.id!=='package'):[];
      if(post.files.length>singles.length){packages.appendChild(el('h4','','字幕包'));files.appendChild(packages);}
      let singleFiles,batch;
      if(singles.length){
        batch=item.batches.get(post.id);
        if(!batch){batch={selected:new Set(),pending:false};item.batches.set(post.id,batch);}
        singleFiles=el('details','subtitle-single-files');
        singleFiles.open=item.singleFilesOpen.get(post.id)===true;
        singleFiles.ontoggle=()=>item.singleFilesOpen.set(post.id,singleFiles.open);
        singleFiles.appendChild(key(el('summary','','单个字幕（'+singles.length+'）'),item.focusId+':single-files:'+post.id));files.appendChild(singleFiles);
        const toolbar=el('div','subtitle-selection-toolbar'),allLabel=el('label','subtitle-select-all'),all=key(el('input'),item.focusId+':all:'+post.id);
        all.type='checkbox';all.checked=singles.every(file=>batch.selected.has(file.id));all.indeterminate=batch.selected.size>0&&!all.checked;all.disabled=batch.pending;
        all.onchange=()=>{for(const file of singles){if(all.checked)batch.selected.add(file.id);else batch.selected.delete(file.id);}redraw(source);};
        allLabel.append(all,el('span','','全选'));toolbar.append(allLabel,el('span','inline-note','已选 '+batch.selected.size+' / '+singles.length));
        const selected=singles.filter(file=>batch.selected.has(file.id)),slots=selected.map(file=>item.files.get(post.id+':'+file.id));
        const busy=batch.pending||slots.some(slot=>slot?.pending||slot?.waiting),ready=slots.filter(slot=>slot?.download).length;
        const get=key(button(batch.pending?'正在下载所选…':'下载所选',safe(()=>downloadSelection(source,row,post,item,batch)),'button small'),item.focusId+':batch-download:'+post.id);get.disabled=!selected.length||busy;toolbar.appendChild(get);
        if(selected.length&&ready)toolbar.appendChild(el('span','inline-note','已就绪 '+ready+' / '+selected.length));
        if(onSelect&&selected.length){
          const preview=key(button('识别所选并预览',safe(()=>{if(busy||ready!==selected.length)return;remember(source);return state.mounted.onSelect([...new Set(slots.flatMap(slot=>slot.download.files))]);}),'button primary small'),item.focusId+':batch-select:'+post.id);
          preview.disabled=busy||ready!==selected.length;toolbar.appendChild(preview);
        }
        singleFiles.appendChild(toolbar);
      }
      for(const file of post.files){
        const fileKey=post.id+':'+file.id;let slot=item.files.get(fileKey);if(!slot){slot={focusId:item.focusId+':file:'+fileKey};item.files.set(fileKey,slot);}
        const attachment=el('div','subtitle-online-attachment'),copy=el('div','subtitle-online-attachment-copy');copy.appendChild(el('strong','',file.name));
        if(source==='acgrip'){
          const meta=require('./subtitle-attachment-meta.cjs').metadata(file);
          if(meta.summary)copy.appendChild(note(meta.summary));
          if(meta.uploaded){const uploaded=el('time','subtitle-attachment-uploaded','上传于 '+meta.uploaded);uploaded.dateTime=meta.uploaded.replace(' ','T');copy.appendChild(uploaded);}
          if(meta.note)copy.appendChild(note(meta.note));
        }else{const description=String(file.note||'').replace(file.name,'').replace(/点击文件名下载附件/g,'').replace(/\(\s*\)|（\s*）/g,'').trim();if(description&&description!=='整个字幕包')copy.appendChild(note(description));}
        if(batch&&file.id!=='package'){
          const select=key(el('input','subtitle-file-select'),item.focusId+':check:'+post.id+':'+file.id);select.type='checkbox';select.checked=batch.selected.has(file.id);select.disabled=batch.pending;select.setAttribute('aria-label','选择 '+file.name);
          select.onchange=()=>{if(select.checked)batch.selected.add(file.id);else batch.selected.delete(file.id);redraw(source);};attachment.appendChild(select);
        }
        const controls=el('div','organizer-actions'),get=key(button(slot.pending?'正在下载…':slot.download?'重新下载':'下载',safe(()=>{if(!slot.pending&&!slot.waiting&&!batch?.pending)return download(source,row,post,file,slot);})),slot.focusId+':download');get.setAttribute('aria-disabled',String(Boolean(slot.pending||slot.waiting||batch?.pending)));controls.appendChild(get);attachment.append(copy,controls);status(source,slot,attachment);
        if(slot.download){const result=slot.download;attachment.appendChild(note(result.warning||'已下载并解压 · '+result.files.length+' 个字幕文件'));controls.appendChild(key(button('打开下载目录',safe(()=>ipc.invoke('subtitle-sources:folder',result.folder))),slot.focusId+':folder'));if(result.files.length&&onSelect)controls.appendChild(key(button('识别并预览',safe(()=>{remember(source);return state.mounted.onSelect(result.files);}),'button primary small'),slot.focusId+':select'));}
        (source==='assrt'&&file.id!=='package'?singleFiles:packages).appendChild(attachment);
      }
      section.appendChild(files);host.appendChild(section);
    }
    for(const [source,label]of sources){
      const group=state.groups.get(source),tab=button(label,()=>selectSource(source),'subtitle-source-tab'+(state.active===source?' active':''));
      const panelId='subtitle-source-'+String(work.id).replace(/[^\w-]/g,'_')+'-'+source;tab.id=panelId+'-tab';tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panelId);tab.setAttribute('aria-selected',String(state.active===source));tab.tabIndex=state.active===source?0:-1;
      tab.onkeydown=event=>{
        const available=sources.map(([id])=>id).filter(id=>state.shown.has(id)),index=available.indexOf(source);
        const targets={Home:available[0],End:available.at(-1),ArrowLeft:available[(index+available.length-1)%available.length],ArrowRight:available[(index+1)%available.length]};
        if(targets[event.key]){event.preventDefault();selectSource(targets[event.key],true);}
      };tabs.appendChild(tab);controls.set(source,tab);
      const panel=el('div','subtitle-source-panel');panel.dataset.source=source;panel.id=panelId;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);panel.hidden=state.active!==source;root.appendChild(panel);
      const content=el('div','subtitle-online-results');panel.appendChild(content);
      function render(options={}){
        if(!current())return;
        const active=root.ownerDocument.activeElement,hadFocus=content.contains(active),oldKey=hadFocus?active.getAttribute('data-subtitle-focus'):null,scroll=viewport()?.scrollTop;
        const detail=group.view==='detail'&&group.details.get(group.selected);if(state.active===source)searchBox.hidden=Boolean(detail);content.replaceChildren();content.setAttribute('aria-busy',String(Boolean(detail?detail.pending:group.pending)));
        if(detail){
          const nav=el('div','subtitle-detail-nav'),back=key(button('返回搜索结果',()=>showResults(source),'button quiet small'),'detail-back:'+source);back.removeAttribute('data-icon-only');nav.appendChild(back);content.append(nav,el('h3','subtitle-detail-title',detail.row.title));
          const host=el('div','subtitle-source-detail');status(source,detail,host);const page=detail.pages.get(detail.page);
          if(page){if(!page.posts.length)host.appendChild(note('本页没有可下载的字幕附件，已隐藏无附件楼层。'));for(const post of page.posts)drawPost(source,detail.row,post,detail,host);
            if(detail.maxPage>1)host.appendChild(pager(source,detail,label+'详情楼层分页',page=>{if(detail.pending||detail.waiting)return;remember(source);if(detail.pages.has(page)){detail.page=page;render();restore(source);}else loadDetail(source,detail.row,detail,page);}));}
          content.appendChild(host);
        }else{
          if(source==='assrt')content.appendChild(open('https://assrt.net/','字幕服务由 assrt.net 提供'));
          status(source,group,content);
          if(group.error?.includes('Token')&&onSettings)content.appendChild(button('打开字幕设置',safe(()=>{remember(source);return onSettings();})));
          const page=group.pages.get(group.page);
          if(page){
            if(!page.rows.length)content.appendChild(note('本页没有搜索结果，可以更换作品别名或返回上一页。'));
            for(const row of page.rows){
              const article=el('article','subtitle-online-result'),head=el('div','subtitle-online-result-heading');
              const title=key(button(row.title,()=>openDetail(source,row),'subtitle-online-title'),source+':'+row.id+':title');title.setAttribute('aria-disabled',String(Boolean(group.pending||group.waiting)));head.append(title,open(row.page));article.appendChild(head);
              const meta=providers[source].metadata(row).filter(Boolean).join(' · ');if(meta)article.appendChild(el('p','subtitle-online-meta',meta));if(row.summary)article.appendChild(el('p','subtitle-online-summary',row.summary));content.appendChild(article);
            }
            content.appendChild(pager(source,group,label+'搜索结果分页',page=>goPage(source,page)));
          }else if(!group.pending&&!group.error&&!group.waiting)content.appendChild(note('输入作品名，在'+label+'搜索字幕。'));
        }
        if((hadFocus&&!active.isConnected)||options.focus){const target=[...content.querySelectorAll('[data-subtitle-focus]')].find(element=>element.getAttribute('data-subtitle-focus')===(options.focus||oldKey));if(target)target.focus({preventScroll:true});else if(hadFocus){const back=content.querySelector('.subtitle-detail-nav button');if(back)back.focus({preventScroll:true});}}
        if(viewport()&&state.active===source)viewport().scrollTop=scroll;
      }
      panels.set(source,{panel,render,focus:()=>{if(group.view==='detail')showResults(source,false);query.focus();}});
    }
    form.onsubmit=event=>{
      event.preventDefault();
      const value=query.value.trim();
      if(!value||!state.selected.size){notice('请输入作品名并选择搜索来源');return;}
      state.query=value;
      state.shown=new Set(state.selected);
      for(const [source,group] of state.groups){
        cancelGroup(group);group.generation++;
        Object.assign(group,freshPages(),{submitted:value,details:new Map(),view:'results',selected:null,listFocus:null,pending:false,error:'',scroll:new Map()});
        controls.get(source).hidden=!state.shown.has(source);
      }
      selectSource(state.shown.has(state.active)?state.active:state.shown.values().next().value);
      for(const source of state.shown)loadSearch(source);
    };
    for(const [source,control] of controls)control.hidden=!state.shown.has(source);
    mounted.panels=panels;for(const panel of panels.values())panel.render();restore(state.active);
    mounted.focus=()=>panels.get(state.active).focus();
  }
  function focus(){[...states.values()].find(state=>state.mounted?.root.isConnected)?.mounted.focus();}
  return {mount,focus};
}
module.exports={create,sources};
