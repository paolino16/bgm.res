'use strict';
const {COLLECTIONS,CATEGORIES,FACETS,TAG_SORTS}=require('./discovery.cjs');
const {pageSource,resultPages}=require('./discovery-pages.cjs');
const {pagination}=require('./pagination.cjs');
const {regularChapters}=require('./episode-catalog.cjs');

function localIndex(works){
  const entries=new Map();
  for(const work of works){
    if(!work.bgmID)continue;
    const key=String(work.bgmID);
    const entry=entries.get(key)||{workId:work.id,episodes:new Set(),works:[]};
    entries.set(key,entry);
    entry.works.push(work);
    for(const [slotKey,slot] of Object.entries(work.EPDetails||{})){
      if(slot.EpisodeType!=null&&Number(slot.EpisodeType)!==0)continue;
      const versions=slot.Versions || [{path:slot.AbsolutePath||slot.URL}];
      if(!versions.some(file=>file.path && (!file.availability||file.availability==='available')))continue;
      const ids=slot.Collection && slot.EpisodeIDs?.length ? slot.EpisodeIDs : [slot.EpisodeID || (slot.Collection?null:work.id+':'+slotKey)];
      for(const id of ids)if(id)entry.episodes.add(String(id));
    }
    for(const file of [...(work.RenameBinding?.files||[]),...(work.RenameBinding?.resources||[])]){
      if(!file.path||(file.availability&&file.availability!=='available'))continue;
      if(file.subjectId&&String(file.subjectId)!==key)continue;
      if(file.type==null||Number(file.type)!==0)continue;
      for(const id of file.collection?file.episodeIds||[]:[file.episodeId])if(id)entry.episodes.add(String(id));
    }
  }
  return entries;
}
function ownedLabel(entry,row,catalogue){
  if(!entry)return '未入库';
  let regular=entry.episodes.size,regularTotal=Number(row.episodes)||0;
  if(Array.isArray(catalogue)){
    const regularIds=new Set();
    regularTotal=catalogue.filter(ep=>Number(ep.type)===0).length;
    for(const work of entry.works){
      for(const ep of regularChapters(work,catalogue).rows)if(ep.state==='mapped')regularIds.add(String(ep.id));
    }
    regular=regularIds.size;
  }
  return '已收录 '+regular+(regularTotal?'/'+regularTotal:'')+' 话';
}

function create({ipc,node,button,setHeader,container,works,find,openExternal,openDetail,restart,catalogue}){
  const listState=()=>({query:'',missing:false,page:1,scroll:0});
  const rank={...listState(),searchBy:'name',tagSort:'match',cat:'',year:'',month:'',sort:'rank',facets:{},uncollected:false};
  const collection={...listState(),type:1};
  let mode='rank',session,version=0,root,field,loginForm=false,cache=new Map();
  let filtersOpen=true;
  let membership,library,filteredViews=new Map();
  const coverRequests=new Map(),coverJobs=new WeakMap();
  const coverObserver=new IntersectionObserver(entries=>{
    for(const item of entries)if(item.isIntersecting){
      coverObserver.unobserve(item.target);coverJobs.get(item.target)?.();
    }
  },{root:container(),rootMargin:'120px 0px'});
  function clearCache(){cache.clear();filteredViews.clear();membership=null;coverRequests.clear();coverObserver.disconnect();}
  function bounded(map,key,build,limit=12){
    if(!map.has(key)){
      if(map.size>=limit)map.delete(map.keys().next().value);
      map.set(key,build());
    }
    return map.get(key);
  }
  function checkSession(response){
    if(response.expired||response.changed)throw Object.assign(Error('登录状态已变化'),{sessionChanged:true});
    return response;
  }
  function collectedIds(){
    if(!membership){
      const pending=ipc.invoke('discovery:collectionIds',{revision:session.revision})
        .then(checkSession).then(result=>new Set(result.ids))
        .catch(error=>{if(membership===pending)membership=null;throw error;});
      membership=pending;
    }
    return membership;
  }
  const active=()=>mode==='rank'?rank:collection;
  function reset(){active().page=1;active().scroll=0;}
  function change(fn){fn();reset();render();}
  function leave(){version++;library=null;filteredViews.clear();coverObserver.disconnect();active().scroll=container().scrollTop;loginForm=false;}
  function select(label,items,value,onChange){
    const el=node('select');el.setAttribute('aria-label',label);
    for(const [id,name] of items)el.add(new Option(name,id));
    el.value=value;el.onchange=()=>change(()=>onChange(el.value));return el;
  }
  function chip(name,selected,click){
    const control=node('button','filter-chip'+(selected?' active':''),name);
    control.type='button';control.setAttribute('aria-pressed',String(selected));control.onclick=click;
    return control;
  }
  function clearAccount(){
    clearCache();rank.uncollected=false;rank.page=collection.page=1;rank.scroll=collection.scroll=0;
    collection.type=1;collection.query='';loginForm=false;
  }
  async function signOut(){
    await ipc.invoke('discovery:logout');clearAccount();session=null;
    if(root?.isConnected)render();
  }
  function accountControls(parent){
    const bar=node('div','discovery-account');
    const label=session.expired?'登录已失效':session.username?'已登录 · '+session.username:'游客视图 · 部分条目可能隐藏';
    bar.append(node('span','',label));
    if(!session.username||session.expired)bar.append(button('登录 Bangumi',()=>{loginForm=true;render();},'button quiet small'));
    if(session.username)bar.append(button(session.expired?'以游客身份浏览':'退出登录',()=>signOut().catch(e=>showError(parent,e)),'button quiet small'));
    parent.append(bar);
    if(!loginForm)return;
    const form=node('form','discovery-login'),input=node('input');
    input.type='password';input.autocomplete='off';input.placeholder='bgm_token';input.required=true;input.setAttribute('aria-label','Bangumi 访问令牌');
    const submit=button('登录',null,'button primary small');submit.type='submit';
    form.append(input,submit,button('取消',()=>{loginForm=false;render();},'button quiet small'));
    form.onsubmit=async event=>{
      event.preventDefault();submit.disabled=true;
      try{await ipc.invoke('discovery:login',input.value);input.value='';clearAccount();session=null;if(root.isConnected)render();}
      catch(e){if(form.isConnected){submit.disabled=false;showError(form,e);}}
    };
    parent.append(form);input.focus();
  }
  function showError(parent,error){
    parent.querySelector('.discovery-error')?.remove();
    const message=node('span','discovery-error',error.message.replace(/^Error invoking remote method .*?: Error: /,''));
    message.setAttribute('role','alert');parent.append(message);
  }
  function controls(parent){
    const s=active(), form=node('form','discovery-controls');
    field=node('input');field.type='search';field.maxLength=200;field.value=s.query;
    field.placeholder=mode==='collection'?'搜索此分类中的动画':'搜索动画名称';field.setAttribute('aria-label',field.placeholder);
    let searchMode;
    if(mode==='rank'){
      searchMode=node('select');searchMode.setAttribute('aria-label','搜索方式');
      const tagOption=new Option('标签','tag');
      tagOption.disabled=!session.apiTagSorting;
      searchMode.add(new Option('名称','name'));searchMode.add(tagOption);
      searchMode.value=rank.searchBy;
      const updateHint=()=>{
        field.placeholder=searchMode.value==='tag'?'输入 Bangumi 标签，多个标签用逗号分隔':'搜索动画名称';
        field.setAttribute('aria-label',field.placeholder);
      };
      searchMode.onchange=()=>{updateHint();field.focus();};updateHint();form.append(searchMode);
    }
    const submit=button('搜索',null,'button quiet small');submit.type='submit';
    form.append(field,submit);
    form.onsubmit=e=>{e.preventDefault();change(()=>{s.query=field.value.trim();if(searchMode)rank.searchBy=searchMode.value;});};
    const missing=node('label','discovery-missing'),check=node('input');check.type='checkbox';check.checked=s.missing;
    check.onchange=()=>change(()=>{s.missing=check.checked;});missing.append(check,'只看未入库');
    if(mode==='rank'){
      const panel=node('details','discovery-filter-panel'),heading=node('summary','','筛选与排序');
      panel.open=filtersOpen;panel.ontoggle=()=>{if(panel.isConnected)filtersOpen=panel.open;};
      const tagSearch=rank.searchBy==='tag'&&Boolean(rank.query);
      const summary=[tagSearch?TAG_SORTS.find(([id])=>id===rank.tagSort)[1]:!rank.query && rank.sort==='date'?'播出日期':'排名',CATEGORIES.find(([id])=>id===rank.cat)?.[1],
        rank.year&&rank.year+' 年',rank.month&&rank.month+' 月',...Object.values(rank.facets),
        rank.missing&&'未入库',rank.uncollected&&'未收藏'].filter(Boolean);
      heading.append(node('span','discovery-filter-summary',summary.join(' · ')));
      const facets=node('div','discovery-facets');
      function add(label,el){
        const fieldLabel=node('label','discovery-filter-field');
        fieldLabel.append(node('span','',label),el);facets.append(fieldLabel);
      }
      const sort=tagSearch?select('排序',TAG_SORTS,rank.tagSort,v=>rank.tagSort=v):
        select('排序',[['rank','排名'],['date','播出日期']],rank.query?'rank':rank.sort,v=>rank.sort=v);
      sort.disabled=!tagSearch&&Boolean(rank.query);if(sort.disabled)sort.title='搜索结果按排名排序';
      add('排序',sort);
      add('形式',select('动画形式',[['','全部'],...CATEGORIES],rank.cat,v=>rank.cat=v));
      const year=new Date().getFullYear()+2;
      add('年份',select('年份',[['','全部'],...Array.from({length:year-1899},(_,i)=>[String(year-i),String(year-i)])],rank.year,v=>rank.year=v));
      add('月份',select('月份',[['','全部'],...Array.from({length:12},(_,i)=>[String(i+1),(i+1)+' 月'])],rank.month,v=>rank.month=v));
      for(const [label,values] of Object.entries(FACETS)){
        const picker=select(label,[['','全部'],...values.map(value=>[value,value])],rank.facets[label]||'',
          value=>{if(value)rank.facets[label]=value;else delete rank.facets[label];});
        picker.disabled=!session.supportsRankFilters;add(label,picker);
      }
      const hide=node('label','discovery-missing'),box=node('input');
      box.type='checkbox';box.checked=rank.uncollected;box.disabled=!session.username||!session.supportsRankFilters;
      if(!session.username)hide.title='登录 Bangumi 后可筛选';
      box.onchange=()=>change(()=>{rank.uncollected=box.checked;});hide.append(box,'只看未收藏');
      const flags=node('div','discovery-filter-flags');flags.append(missing,hide);
      panel.append(heading,facets,flags);form.append(panel);
    }else form.append(missing);
    parent.append(form);
  }
  function coverView(row){
    const cover=node('div','discovery-cover'),img=node('img'),revision=session.revision;
    const usable=url=>typeof url==='string'&&/^https:\/\/(?:lain\.bgm\.tv|lain\.bangumi\.tv)\/(?:r\/\d+\/)?pic\/cover\//.test(url);
    img.loading='lazy';img.alt='';
    const attempted=new Set();
    function display(url){
      attempted.add(url);img.src=url;if(!img.parentNode)cover.append(img);
    }
    function fallback(){
      if(!session?.username||revision!==session.revision||!Number.isSafeInteger(row.id))return;
      coverJobs.set(cover,async()=>{
        const key=revision+':'+row.id;
        const pending=bounded(coverRequests,key,()=>ipc.invoke('discovery:titles',{id:row.id,revision}).then(info=>info?.images||{}),128);
        try{
          const images=await pending;
          if(!cover.isConnected||session?.revision!==revision)return;
          const urls=[images.small,images.common,images.large,images.grid].filter(usable);
          function next(){
            const url=urls.find(value=>!attempted.has(value));
            if(url)display(url);else img.remove();
          }
          img.onerror=next;next();
        }catch{if(coverRequests.get(key)===pending)coverRequests.delete(key);}
      });
      coverObserver.observe(cover);
    }
    if(usable(row.cover)){img.onerror=()=>{img.remove();if(cover.isConnected)fallback();};display(row.cover);}else fallback();
    return cover;
  }
  function rowView(row,local){
    const line=node('article','discovery-row'), cover=coverView(row);
    const info=node('div','discovery-name'), name=row.cn||row.name;
    const entry=local.get(String(row.id));
    const title=node('strong','',name),meta=node('small');
    function localLink(text){
      const link=node('a','discovery-subject-link',text);
      link.href='#'+encodeURIComponent(entry.workId);link.title='在媒体库打开「'+name+'」';
      link.onclick=event=>{event.preventDefault();openDetail(entry.workId);};
      link.onauxclick=event=>{if(event.button===1)link.onclick(event);};
      return link;
    }
    if(Number.isSafeInteger(row.id)&&row.id>0){
      const link=node('a','discovery-subject-link',name);
      link.href='https://bgm.tv/subject/'+row.id;
      link.title='在 Bangumi 打开「'+name+'」';
      link.onclick=event=>{event.preventDefault();openExternal(link.href).catch(e=>showError(info,e));};
      link.onauxclick=event=>{if(event.button===1)link.onclick(event);};
      if(entry){
        link.textContent='Bangumi ↗';link.classList.add('discovery-original');
        title.replaceChildren(localLink(name));
        meta.append(link);
      }else title.replaceChildren(link);
    }
    info.append(title);
    const details=[row.name!==name && row.name,row.platform,row.date?.slice(0,4),row.episodes && row.episodes+' 话'].filter(Boolean);
    meta.prepend(details.join(' · '));info.append(meta);
    const owned=ownedLabel(entry,row);
    const status=node('span','discovery-owned',owned);
    if(entry){
      const link=localLink(owned);status.replaceChildren(link);
      if(catalogue)void Promise.resolve().then(()=>catalogue(row.id)).then(episodes=>{
        if(!status.isConnected)return;
        link.textContent=ownedLabel(entry,row,episodes);
      }).catch(()=>{
        if(status.isConnected)status.title='章节目录暂不可用，暂按本地已登记的正片数量显示';
      });
    }
    line.append(node('span','discovery-rank',row.rank?'#'+row.rank:'—'),cover,info,
      node('span','discovery-score',row.score?row.score+' 分':'暂无评分'),status,
      button('找资源',async event=>{
        const control=event.currentTarget;
        control.disabled=true;
        let names={name:row.name,name_cn:row.cn};
        try{
          // The slim collection payload omits aliases and country of production.
          if(!/[ぁ-ヿ]/u.test(row.name) && /[一-龯]/u.test(row.name)){
            try{names=await ipc.invoke('discovery:titles',{id:row.id,revision:session.revision})||names;}catch{}
          }
          if(control.isConnected)await find(row,names);
        }finally{control.disabled=false;}
      },'button quiet small'));
    return line;
  }
  async function render(){
    const ticket=++version,viewport=container();
    setHeader('发现','Bangumi 排行榜与我的收藏');
    if(!root?.isConnected){
      root=node('section','discovery');
      root.append(node('div','discovery-header'),node('div','discovery-results'));
      viewport.replaceChildren(root);
    }
    const here=root.firstElementChild,list=root.lastElementChild,valid=()=>version===ticket&&here.isConnected;
    list.setAttribute('aria-busy','true');
    if(!list.childElementCount)list.append(node('p','inline-note','正在读取…'));
    const progress=node('p','inline-note discovery-progress','正在更新筛选结果…');
    progress.setAttribute('role','status');
    const waiting=setTimeout(()=>{
      if(valid()&&list.getAttribute('aria-busy')==='true')list.prepend(progress);
    },350);
    try{
      const next=await ipc.invoke('discovery:status');if(!valid())return;
      if(!session||session.revision!==next.revision){
        if(session)clearAccount();
        list.replaceChildren();
      }
      session=next;here.replaceChildren();
      const top=node('div','discovery-top'),tabs=node('div','discovery-tabs');
      for(const [id,label] of [['rank','排行榜'],['collection','我的收藏']])tabs.append(chip(label,id===mode,()=>{
        active().scroll=viewport.scrollTop;mode=id;render();
      }));
      top.append(tabs);here.append(top);accountControls(top);
      if(mode==='rank'&&(!session.supportsRankFilters||!session.apiTagSorting)){
        const note=node('div','inline-note','后台仍在运行旧版本。重启应用后可使用最新搜索与筛选功能。 ');
        note.append(button('重启应用',restart,'button quiet small'));here.append(note);
      }
      if(!session.expired&&(mode==='rank'||session.username)){
        top.querySelector('.discovery-account').append(button('刷新列表',async()=>{try{await ipc.invoke('discovery:invalidate');}catch(e){if(session.apiTagSorting){showError(here,e);return;}}clearCache();reset();render();},'button quiet small'));
      }
      if(session.expired || (mode==='collection'&&!session.username)){
        list.replaceChildren();list.removeAttribute('aria-busy');
        here.append(node('p','inline-note',session.expired?'重新登录后可继续查看账号可见的条目。':'登录后可查看自己的动画收藏。'));return;
      }
      if(mode==='collection'){
        const types=node('div','discovery-tabs');
        for(const [id,label] of COLLECTIONS)types.append(chip(label,id===collection.type,()=>change(()=>{collection.type=id;})));
        here.append(types);
      }
      controls(here);
      const s=active(),local=library??=localIndex(works());
      const tags=Object.values(rank.facets);
      const dateBrowse=mode==='rank' && !s.query && rank.sort==='date';
      const requestFilters=mode==='collection'?{type:collection.type}:
        {query:s.query,searchBy:rank.searchBy,tagSort:rank.tagSort,sort:rank.sort,cat:rank.cat,year:rank.year,month:rank.month,facets:{...rank.facets}};
      const excludes=mode==='rank' && rank.uncollected;
      const searched=mode==='rank' && (s.query || (tags.length&&!dateBrowse));
      const platform=CATEGORIES.find(([id])=>id===rank.cat)?.[1];
      const filterPlatform=searched&&platform,filterMonth=searched&&rank.month&&!rank.year;
      const collectionQuery=mode==='collection' && s.query.toLocaleLowerCase();
      const checkTags=dateBrowse && tags.length;
      const filtered=Boolean(s.missing||excludes||filterPlatform||filterMonth||collectionQuery||checkTags);
      const context={mode,...requestFilters,revision:session.revision,...(filtered?{scan:true}:{})};
      const key=JSON.stringify(context);
      const read=bounded(cache,key,()=>pageSource(offset=>ipc.invoke('discovery:page',{...context,offset}).then(checkSession)));
      if(!list.childElementCount)list.append(node('p','inline-note',excludes&&!membership?'正在读取收藏列表…':'正在读取…'));
      const collected=excludes?await collectedIds():null;
      if(!valid())return;
      const viewKey=JSON.stringify([key,collectionQuery,s.missing,excludes]);
      const load=bounded(filteredViews,viewKey,()=>{
        const missing=s.missing,month=Number(rank.month);
        function eligible(row){
          if(missing&&local.has(String(row.id)))return false;
          if(collected?.has(row.id))return false;
          if(filterPlatform&&row.platform!==platform)return false;
          if(filterMonth&&Number(row.date.slice(5,7))!==month)return false;
          if(checkTags&&!tags.every(tag=>row.tags?.includes(tag)))return false;
          return !collectionQuery||(row.cn+' '+row.name).toLocaleLowerCase().includes(collectionQuery);
        }
        return resultPages(read,filtered?eligible:null,{scanAhead:3});
      });
      const current=s.page,result=await load(current,valid,scanned=>{
        if(!valid())return;
        progress.textContent='已检查 '+scanned+' 部，正在继续筛选…';
        if(list.firstChild!==progress||list.childElementCount!==1)list.replaceChildren(progress);
      });
      if(!valid())return;
      if(!result.rows.length){
        if(result.pages>0&&current>1){s.page=Math.min(current-1,result.pages);return render();}
        s.page=1;s.scroll=0;
        const empty=node('p','inline-note','没有符合条件的动画');empty.setAttribute('role','status');
        list.replaceChildren(empty);list.removeAttribute('aria-busy');viewport.scrollTop=0;return;
      }
      coverObserver.disconnect();
      list.removeAttribute('aria-busy');list.replaceChildren(...result.rows.map(row=>rowView(row,local)));
      let pager;
      function drawPager(pages,more){
        pager?.remove();
        if(pages<=1&&!more)return;
        pager=pagination({node,button,page:current,pages:Math.max(current,pages),hasMore:more,
          onChange:page=>{s.page=page;s.scroll=0;render();},className:'resource-pagination',label:'动画列表分页'});
        list.append(pager);
      }
      drawPager(result.pages,result.more);
      viewport.scrollTop=s.scroll;
      // A filtered "next page" may require walking the entire remaining ranking.
      // Its bounded scan window already warms nearby batches without that crawl.
      if(!filtered && (current<result.pages||result.more)){
        load(current+1,valid).catch(error=>{if(valid()&&error.sessionChanged){clearCache();render();}});
      }
    }catch(e){
      if(!valid())return;
      if(e.sessionChanged){clearCache();return render();}
      list.removeAttribute('aria-busy');list.replaceChildren();showError(here,e);
      here.append(button('重试',()=>render(),'button quiet small'));
    }finally{clearTimeout(waiting);}
  }
  async function preload(){
    try{
      const current=await ipc.invoke('discovery:status');
      if(current.expired)return;
      const revision=current.revision;
      await ipc.invoke('discovery:page',{mode:'rank',sort:'rank',revision,offset:0});
      if(current.username&&current.apiTagSorting)await ipc.invoke('discovery:collectionIds',{revision});
    }catch{/* Foreground requests retry and show actionable failures. */}
  }
  return {preload,render,leave,focus:()=>field?.focus(),refreshLibrary:()=>{library=null;filteredViews.clear();active().scroll=container().scrollTop;render();}};
}
module.exports={create,localIndex,ownedLabel};
