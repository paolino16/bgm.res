'use strict';
const names = {dmhy:'动漫花园',mikan:'蜜柑计划',anibt:'AniBT',nyaa:'Nyaa',knaben:'Knaben',ext:'EXT'};
const hosts = {dmhy:'share.dmhy.org',mikan:'mikan.sakuramoe.dev',anibt:'anibt.net',nyaa:'nyaa.si',knaben:'knaben.org',ext:'ext.to'};
const {pagination}=require('./pagination.cjs');
const {highlightTitle,createMatcher,normalizeKeywords,defaultKeywords,loadKeywords}=require('./resource-keywords.cjs');
const {rowHash}=require('./seadex.cjs');

function groups(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = rowHash(row) || row.page;
    if (!merged.has(key)) merged.set(key,[]);
    merged.get(key).push(row);
  }
  return [...merged.values()].sort((a,b)=>newest(b)-newest(a));
}
function newest(group) {
  return Math.max(0,...group.map(r=>Date.parse(r.date)||0));
}
function formatSize(value) {
  if (!value) return '';
  if (!/^\d+$/.test(value)) return value;
  const bytes=Number(value);
  if (!bytes) return '';
  if(bytes<1024)return bytes+' B';
  if(bytes<2**20)return Math.round(bytes/1024)+' KiB';
  return bytes>=2**30?(bytes/2**30).toFixed(1)+' GiB':Math.round(bytes/2**20)+' MiB';
}
function create({ipc,node,button,shell,notice,setHeader,container,downloadSettings}) {
  const preview=require('./torrent-preview.cjs').createFilePreview({ipc,node,button,formatSize});
  let saved;
  try {
    saved=JSON.parse(localStorage.getItem('resource-sources'));
    if(localStorage.getItem('resource-sources-version')!=='2'){
      if(Array.isArray(saved))saved=[...saved.filter(source=>source!=='ext'),'knaben'];
      if(Array.isArray(saved))localStorage.setItem('resource-sources',JSON.stringify([...new Set(saved)]));
      localStorage.setItem('resource-sources-version','2');
    }
  } catch {}
  const selected=new Set(Array.isArray(saved)?saved.filter(s=>Object.hasOwn(names,s)):Object.keys(names).filter(source=>source!=='ext'));
  let keywords=loadKeywords(localStorage);
  let matchTitle=createMatcher(keywords), highlightedOnly=false, seaOnly=false;
  const seaMatches=new Map(),seaPending=new Set();
  let seaError='',seaScheduled=false;
  let query='', submitted='', generation=0, choices=[], enabled=false, panel, status, results, input, submit;
  let batches=new Map(), states=new Map();
  let currentPage=1, pageStarts=[0], orderLocked=false, nextRank=0, paging=false, paginationVersion=0;
  const positions=new Map();
  let prefetching=null;
  const cursors=new Map();
  const busy=new Set();
  const jumpDraft={};
  function readySources(){return [...selected].filter(s=>s!=='ext'||enabled);}
  function isLoading(source){return ['loading','prefetching'].includes(states.get(source));}
  function updateButton(){submit.disabled=!input.value.trim()||!readySources().length;}
  function resetPagination(){
    paginationVersion++;currentPage=1;pageStarts=[0];orderLocked=false;nextRank=0;paging=false;prefetching=null;positions.clear();
  }
  function filtering(){return highlightedOnly||seaOnly;}
  function seaMatch(group){
    const hits=group.map(row=>seaMatches.get(rowHash(row))).filter(Boolean);
    return hits.find(hit=>hit.level==='best')||hits[0];
  }
  function matchesSeaDex(group){
    return !seaOnly||Boolean(seaMatch(group));
  }
  function refreshSeaDex(){
    if(seaScheduled||seaError)return;
    const token=generation;
    seaScheduled=true;
    void Promise.resolve().then(async()=>{
      if(token!==generation)return;
      seaScheduled=false;
      const hashes=[...new Set(allGroups().flatMap(group=>group.map(rowHash)).filter(Boolean))]
        .filter(hash=>!seaMatches.has(hash)&&!seaPending.has(hash)).slice(0,200);
      if(!hashes.length)return;
      for(const hash of hashes)seaPending.add(hash);
      drawResults();
      let success=false;
      try{
        const value=await ipc.invoke('resources:seadex',hashes);
        if(token!==generation)return;
        if(!value?.matches||hashes.some(hash=>!Object.hasOwn(value.matches,hash)))throw Error('SeaDex 返回格式无效');
        for(const hash of hashes){
          const hit=value.matches[hash];
          if(hit!==null&&!['best','alt'].includes(hit?.level))throw Error('SeaDex 返回格式无效');
        }
        for(const hash of hashes)seaMatches.set(hash,value.matches[hash]);
        success=true;
      }catch(error){if(token===generation)seaError=error.message||'SeaDex 暂不可用';}
      finally{
        if(token===generation){
          for(const hash of hashes)seaPending.delete(hash);
          drawResults();
          if(success)refreshSeaDex();
        }
      }
    });
  }
  function resetSeaDex(){seaMatches.clear();seaPending.clear();seaError='';seaScheduled=false;}
  function matches(row){
    return !highlightedOnly||matchTitle(row.title).some(part=>part.highlight);
  }
  function allGroups(){return groups(readySources().flatMap(source=>batches.get(source)||[]));}
  function resultGroups(){
    const list=allGroups().filter(group=>group.some(matches)&&matchesSeaDex(group));
    if(!orderLocked)return list;
    const ranked=[],remaining=[];
    for(const group of list){
      const known=group.map(row=>positions.get(row.page)).filter(rank=>rank!==undefined);
      if(known.length)ranked.push({group,rank:Math.min(...known)});
      else remaining.push(group);
    }
    // Published pages stay fixed. Unpublished results retain the date order from groups().
    return [...ranked.sort((a,b)=>a.rank-b.rank).map(item=>item.group),...remaining];
  }
  function freezePage(end){
    for(const group of resultGroups().slice(0,end)){
      const known=group.map(row=>positions.get(row.page)).filter(rank=>rank!==undefined);
      const rank=known.length?Math.min(...known):nextRank++;
      for(const row of group)positions.set(row.page,rank);
    }
    orderLocked=true;
  }
  function refillSources(list,end){
    const remaining=list.slice(end);
    const active=readySources().filter(source=>cursors.has(source)||remaining.some(group=>group.some(row=>row.source===source)));
    const share=Math.ceil(50/Math.max(active.length,1));
    return active.filter(source=>cursors.has(source)&&states.get(source)==='ok'&&
      (remaining.length<50||remaining.filter(group=>group.some(row=>row.source===source)).length<share));
  }
  function pageCount(list=resultGroups()){
    let fixed=pageStarts.length-1;
    while(fixed>0&&pageStarts[fixed-1]>=list.length)fixed--;
    const end=Math.min(pageStarts[fixed],list.length);
    return Math.max(1,fixed+Math.ceil((list.length-end)/50));
  }
  function goToPage(page){
    if(paging||!Number.isSafeInteger(page)||page<1)return;
    if(page>pageCount()){
      if(page===currentPage+1)return nextPage();
      return;
    }
    const list=resultGroups();
    const end=pageStarts[currentPage]??Math.min(pageStarts[currentPage-1]+50,list.length);
    freezePage(end);pageStarts[currentPage]=end;
    showPage(page);
  }
  function showPage(page){
    currentPage=page;
    const count=resultGroups().length;
    for(let index=pageStarts.length;index<=page;index++)pageStarts[index]=Math.min(pageStarts[index-1]+50,count);
    freezePage(pageStarts[page]);
    drawResults();
    container().scrollTop=0;
    results.focus({preventScroll:true});
  }
  function prefetch(){
    // Filtering examines fetched results only; sparse matches must not trigger
    // an unbounded crawl of every source. Further batches are explicitly loaded.
    if(filtering())return null;
    if(prefetching)return prefetching;
    const sources=readySources();
    if(!submitted || !panel?.isConnected || sources.some(source=>!states.has(source)||isLoading(source)))return null;
    const list=resultGroups();
    const end=pageStarts[currentPage]??Math.min(pageStarts[currentPage-1]+50,list.length);
    if(!list.length || !refillSources(list,end).length)return null;
    const token=generation, version=paginationVersion;
    freezePage(end);pageStarts[currentPage]=end;
    const task=Promise.resolve().then(async()=>{
      while(token===generation && version===paginationVersion && panel?.isConnected){
        const available=resultGroups();
        const boundary=pageStarts[currentPage]??Math.min(pageStarts[currentPage-1]+50,available.length);
        const more=refillSources(available,boundary);
        if(!more.length)break;
        await Promise.all(more.map(source=>run(source,token,true)));
      }
    }).finally(()=>{
      if(prefetching===task){prefetching=null;drawResults();}
    });
    prefetching=task;
    return task;
  }
  async function nextPage(){
    if(paging)return;
    const token=generation;
    const version=paginationVersion;
    const list=resultGroups();
    const end=pageStarts[currentPage]??Math.min(pageStarts[currentPage-1]+50,list.length);
    freezePage(end);pageStarts[currentPage]=end;
    if(end<list.length){showPage(currentPage+1);return;}
    paging=true;drawResults();
    try{
      await prefetch();
    }finally{
      if(token===generation && version===paginationVersion){
        paging=false;
        if(resultGroups().length>end)showPage(currentPage+1);
        else drawResults();
      }
    }
  }
  function drawResults(){
    if(!panel?.isConnected)return;
    const sources=readySources();
    const list=resultGroups();
    while(currentPage>1 && pageStarts[currentPage-1]>=list.length)currentPage--;
    const start=pageStarts[currentPage-1];
    const end=pageStarts[currentPage]??Math.min(start+50,list.length);
    status.replaceChildren();
    results.replaceChildren();
    if(!submitted)return;
    status.append(node('span','',filtering()?list.length+' 条匹配 / 已获取 '+allGroups().length+' 条':list.length+' 条结果'));
    if(seaPending.size)status.append(node('span','','SeaDex 核对中…'));
    if(seaError){
      const retry=button('SeaDex 暂不可用 · 重试',()=>{seaError='';refreshSeaDex();drawResults();},'button quiet small');
      retry.title=seaError;status.append(retry);
    }
    if(seaOnly){
      const unknown=allGroups().filter(group=>group.every(row=>!rowHash(row))).length;
      if(unknown)status.append(node('span','',unknown+' 条未提供 hash，无法核对 SeaDex'));
    }
    for(const source of sources){
      const state=states.get(source);
      if(!state)continue;
      if(state==='loading')status.append(node('span','',names[source]+' 搜索中…'));
      else if(state==='prefetching')continue;
      else if(state==='empty')status.append(node('span','',names[source]+' 无结果'));
      else if(state==='ok'&&source==='ext')status.append(node('span','','EXT '+batches.get(source).length+' 条'));
      else if(state!=='ok'){
        const label=source==='ext'&&state.includes('站点验证')?'EXT 验证未完成':names[source];
        const retry=button(label+' · 重试',()=>run(source,generation),'button quiet small');
        retry.title=state;status.append(retry);
      }
    }
    if(sources.some(source=>states.get(source)==='prefetching'))status.append(node('span','','后台预取中…'));
    for(const group of list.slice(start,end)){
      const row=group.find(matches)||group[0], entry=node('article','resource-row'), body=node('div','resource-info');
      const title=node('button','resource-title preview-link',row.title);
      highlightTitle(title,row.title,node,matchTitle);
      title.type='button';title.title='查看种子文件清单';title.setAttribute('aria-haspopup','dialog');
      title.onclick=()=>preview(group,panel);
      body.append(title);
      const meta=node('div','resource-meta');
      const recommendation=seaMatch(group);
      if(recommendation){
        const badge=button('SeaDex '+(recommendation.level==='best'?'Best':'Alt'),()=>{
          const url=recommendation.entries?.find(entry=>/^https:\/\/seadex\.moe\/\d+$/.test(entry.url))?.url||'https://seadex.moe/';
          shell.openExternal(url).catch(error=>notice(error.message));
        },'resource-seadex '+recommendation.level);
        badge.title=['按种子 hash 精确匹配；点击查看 SeaDex 条目',...(recommendation.tags||[]),
          ...(recommendation.entries||[]).map(entry=>entry.notes).filter(Boolean)].join('\n');
        meta.append(badge);
      }
      for(const source of new Set(group.map(r=>r.source))){
        const hit=group.find(r=>r.source===source),link=node('a','resource-source',names[source]);
        try {
          const url=new URL(hit.page);
          const allowed=source==='mikan'?['mikanani.me',hosts.mikan]:[hosts[source]];
          if(!['http:','https:'].includes(url.protocol)||!allowed.includes(url.hostname))continue;
          url.protocol='https:';link.href=url.href;
          if(hit.origin)link.title=names[source]+' · '+hit.origin;
          link.onclick=e=>{e.preventDefault();shell.openExternal(url.href).catch(e=>notice(e.message));};
        } catch {continue;}
        meta.append(link);
      }
      const size=group.map(r=>formatSize(r.size)).find(Boolean);
      meta.append(node('span','',size||'大小未知'));
      const date=newest(group);
      if(date)meta.append(node('time','',new Date(date).toLocaleDateString('zh-CN')));
      const seed=group.find(r=>r.seeds!=null && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(String(r.seeds).trim()));
      const count=node('span','',seed?'做种 '+String(seed.seeds).trim():'做种数未知');
      count.title=seed?names[seed.source]:'来源未提供做种数';meta.append(count);
      body.append(meta);
      const actions=node('div','resource-actions');
      for(const [intent,label] of [['open','用 qBittorrent 打开'],['copy','复制磁链']]){
        const hit=intent==='open'?(group.find(r=>r.torrent)||row):(group.find(r=>r.magnet)||group.find(r=>r.hash)||row);
        const control=button(label,async()=>{
          const token=generation;busy.add(hit.page);drawResults();
          try{
            const value=await ipc.invoke('resources:action',{row:hit,action:intent});
            if(value.hash)hit.hash=value.hash;
            if(value.magnet)hit.magnet=value.magnet;
            if(token===generation)refreshSeaDex();
            if(token===generation && panel.isConnected && !value.cancelled)notice(intent==='copy'?'已复制磁链':'已交给 qBittorrent');
          } catch(e){if(panel.isConnected)notice(e.message);}
          finally{busy.delete(hit.page);drawResults();}
        },'button quiet small');
        control.disabled=group.some(r=>busy.has(r.page));actions.append(control);
      }
      entry.append(body,actions);results.append(entry);
    }
    if(list.length){
      const loading=paging||sources.some(isLoading);
      const more=!filtering()&&sources.some(source=>cursors.has(source)&&states.get(source)==='ok');
      results.append(pagination({node,button,page:currentPage,pages:pageCount(list),onChange:goToPage,
        className:'resource-pagination',label:'资源结果分页',busy:paging,hasMore:more||Boolean(prefetching),
        draft:jumpDraft,contextKey:paginationVersion,
        nextDisabled:(end>=list.length&&loading&&!prefetching)||(end>=list.length&&!more&&!prefetching)}));
      if(end>=list.length && sources.every(source=>!cursors.has(source)&&['ok','empty'].includes(states.get(source)))){
        const endLabel=node('p','resource-list-end','没有更多结果了');
        endLabel.setAttribute('role','status');results.append(endLabel);
      }
    }
    if(!list.length && filtering())results.append(node('p','resource-list-end',seaOnly&&seaPending.size?
      '正在核对 SeaDex 推荐版本…':'已获取的结果中没有匹配项，可调整筛选条件。'));
    if(filtering()&&sources.some(source=>cursors.has(source))){
      const more=button('加载更多结果继续筛选',async()=>{
        await Promise.all(readySources().filter(source=>cursors.has(source)&&states.get(source)==='ok').map(source=>run(source,generation,true)));
      },'button quiet small');
      more.disabled=sources.some(isLoading)||!sources.some(source=>cursors.has(source)&&states.get(source)==='ok');
      results.append(more);
    }
    void prefetch();
  }

  async function run(source,token,background=false){
    states.set(source,background?'prefetching':'loading');drawResults();
    try{
      const accumulated=batches.get(source)||[];
      const urls=new Set(accumulated.map(row=>row.page));
      const seenCursors=new Set();
      while(token===generation){
        const cursor=cursors.get(source)??null;
        seenCursors.add(JSON.stringify(cursor));
        const {rows,next}=await ipc.invoke('resources:search',{source,query:submitted,cursor});
        if(token!==generation)return;
        const before=urls.size;
        for(const row of rows){
          if(urls.has(row.page))continue;
          urls.add(row.page);accumulated.push(row);
        }
        batches.set(source,accumulated);
        if(next==null||seenCursors.has(JSON.stringify(next))){cursors.delete(source);break;}
        cursors.set(source,next);
        if(urls.size>before || !panel.isConnected || !readySources().includes(source))break;
      }
      states.set(source,accumulated.length||cursors.has(source)?'ok':'empty');
    }catch(e){if(token!==generation)return;states.set(source,e.message);}
    refreshSeaDex();
    drawResults();
  }
  function search(){
    if(!query.trim()||!readySources().length)return;
    generation++;resetSeaDex();resetPagination();submitted=query.trim();batches.clear();states.clear();cursors.clear();
    for(const source of readySources())run(source,generation);
  }
  function preset(values){
    generation++;resetSeaDex();resetPagination(); choices=values; query=values[0]?.[1]||'';submitted='';batches.clear();states.clear();cursors.clear();
  }
  function clearNames(){
    choices=[];
    panel?.querySelector('.resource-query select')?.remove();
  }
  function render(){
    setHeader('资源搜索','搜索动画资源');
    if(panel?.isConnected)return;
    panel=node('section','resource-search');container().replaceChildren(panel);
    const form=node('form','resource-query'), field=node('label','search');
    input=node('input');input.type='search';input.placeholder='搜索番名、字幕组或关键词…';input.setAttribute('aria-label','资源关键词');input.value=query;input.maxLength=300;
    input.oninput=()=>{query=input.value;if(!choices.some(c=>c[1]===query))clearNames();updateButton();};field.append(input);form.append(field);
    if(choices.length>1){
      const picker=node('select');picker.setAttribute('aria-label','搜索名称');
      for(const [label,value] of choices)picker.add(new Option(label,value));
      picker.value=choices.find(c=>c[1]===query)?.[1]||choices[0][1];
      picker.onchange=()=>{input.value=query=picker.value;updateButton();input.focus();};
      form.append(picker);
    }
    submit=button('搜索',null,'button primary');submit.type='submit';form.append(submit);
    form.onsubmit=e=>{e.preventDefault();search();};
    const chips=node('div','resource-filters');chips.setAttribute('role','group');chips.setAttribute('aria-label','搜索来源');
    const toggles={};
    function sync(){
      for(const [source,chip] of Object.entries(toggles)){
        chip.disabled=source==='ext'&&!enabled;
        const active=selected.has(source)&&!chip.disabled;
        chip.classList.toggle('active',active);chip.setAttribute('aria-pressed',String(active));
        if(chip.disabled)chip.title='在偏好设置中启用 EXT';
      }
      updateButton();
      if(submitted){
        for(const source of readySources())if(!states.has(source))run(source,generation);
      }
      drawResults();
    }
    for(const [source,label] of Object.entries(names)){
      const chip=button(label,()=>{
        if(selected.has(source))selected.delete(source);else selected.add(source);
        resetPagination();
        localStorage.setItem('resource-sources',JSON.stringify([...selected]));sync();
      },'filter-chip');
      toggles[source]=chip;chips.append(chip);
    }
    status=node('div','resource-status');status.setAttribute('role','status');results=node('div','resource-results');results.tabIndex=-1;
    const filters=node('div','resource-keyword-filters');
    const only=button('只看高亮',()=>{
      highlightedOnly=!highlightedOnly;if(highlightedOnly)seaOnly=false;
      syncFilter();resetPagination();drawResults();
    },'filter-chip');
    const seaToggle=button('只看 SeaDex',()=>{
      seaOnly=!seaOnly;if(seaOnly)highlightedOnly=false;
      syncFilter();resetPagination();drawResults();
    },'filter-chip');
    seaToggle.title='只显示 SeaDex 按种子 hash 精确匹配的 Best 或 Alt';
    function syncFilter(){
      only.classList.toggle('active',highlightedOnly);only.setAttribute('aria-pressed',String(highlightedOnly));
      seaToggle.classList.toggle('active',seaOnly);seaToggle.setAttribute('aria-pressed',String(seaOnly));
    }
    syncFilter();
    const clear=button('清除筛选',()=>{
      highlightedOnly=false;seaOnly=false;syncFilter();resetPagination();drawResults();
    },'button quiet small');
    filters.append(only,seaToggle,clear);
    const editor=node('details','resource-keyword-editor');
    editor.append(node('summary','','编辑高亮名单'));
    const customLabel=node('label','resource-keyword-label','完整名单，每行一个关键词或别名，可直接增删；清空并保存可关闭关键词高亮。');
    const customInput=node('textarea');customInput.rows=6;customInput.maxLength=8000;customInput.value=keywords.join('\n');
    customInput.placeholder='例如：VCB-Studio、ReinForce、喜欢的字幕组';customInput.setAttribute('aria-label','高亮关键词名单');customLabel.append(customInput);
    function saveKeywords(next){
      try{localStorage.setItem('resource-highlight-keywords',JSON.stringify(next));}
      catch{notice('关键词保存失败，请重试');return;}
      keywords=next;matchTitle=createMatcher(next);customInput.value=next.join('\n');resetPagination();drawResults();
      notice('已保存 '+next.length+' 个高亮关键词');
    }
    const save=button('保存名单',()=>saveKeywords(normalizeKeywords(customInput.value)),'button quiet small');
    const restore=button('恢复默认名单',()=>saveKeywords(defaultKeywords()),'button quiet small');
    const editorActions=node('div','resource-keyword-editor-actions');editorActions.append(save,restore);
    editor.append(customLabel,editorActions);
    panel.append(form,chips,filters,editor,status,results);sync();input.focus();
    ipc.invoke('resources:settings').then(pref=>{enabled=pref.enabled;if(chips.isConnected)sync();}).catch(e=>notice(e.message));
  }
  function settings(content){
    const card=node('section','settings-card'),row=node('label','settings-row'),toggle=node('input','appearance-toggle');
    toggle.type='checkbox';toggle.disabled=true;
    row.append(node('span','','启用 EXT · 启动时预热'),toggle);
    const folder=node('p');card.append(node('h3','','资源搜索'),row,folder);content.append(card);
    ipc.invoke('resources:settings').then(pref=>{
      if(pref.webui && card.isConnected)downloadSettings(content,pref.webui);
      enabled=pref.enabled;toggle.checked=enabled;toggle.disabled=false;folder.textContent='种子保存目录：'+pref.folder;
    }).catch(()=>{folder.textContent='无法读取搜索设置';});
    toggle.onchange=async()=>{
      toggle.disabled=true;
      try{await ipc.invoke('resources:enable',toggle.checked);enabled=toggle.checked;}
      catch(e){toggle.checked=enabled;notice(e.message);}finally{toggle.disabled=false;}
    };
  }
  return {render,preset,settings,clearNames,focus:()=>input?.focus()};
}
module.exports={create,groups};
