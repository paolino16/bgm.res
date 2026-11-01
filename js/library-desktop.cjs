'use strict';
const {ipcRenderer:ipc,shell}=require('electron');
const fs=require('fs');
const path=require('path');
const {pathToFileURL}=require('url');
const {mediaType,watchedThrough,episodePath,episodeLink}=require('./js/desktop-actions.cjs');
const {specialWatched,specialThrough,specialToggle}=require('./js/special-chapter-actions.cjs');
const {loadCatalogue,specialChapters}=require('./js/episode-catalog.cjs');
const {summaryLabel}=require('./js/subtitle-index.cjs');
const {airDateLabel,compareAirDates}=require('./js/air-date.cjs');
const $=selector=>document.querySelector(selector);
const appearance={background:localStorage.getItem('appearance-background')!=='off',glass:localStorage.getItem('appearance-glass')!=='off'};
function applyAppearance(){
  document.body.dataset.background=appearance.background?'on':'off';
  document.body.dataset.glass=appearance.glass?'on':'off';
}
applyAppearance();
const smoothScroller=require('./js/smooth-scroll.cjs').install({element:$('#content'),window});
const imageObserver=new IntersectionObserver(entries=>{
  for(const {target,isIntersecting}of entries){
    if(isIntersecting){if(!target.hasAttribute('src'))target.src=target.dataset.source;}
    else target.removeAttribute('src');
  }
},{root:$('#content'),rootMargin:'240px 0px'});
const savedSort=localStorage.getItem('library-sort');
const initialSort=['name','year','score','progress'].includes(savedSort)?savedSort:'name';
const state={data:{},view:'library',filter:'all',query:'',year:'',type:'',sort:initialSort,subtitle:'',mode:localStorage.getItem('library-view')||'grid',id:null,tab:'chapters',selected:null,token:0,busy:false};
const apiCache=new Map();
const episodeNames=new Map();
const catalogueCache=new Map();
function episodeCatalogue(id){const key=String(id);if(!catalogueCache.has(key)){const pending=loadCatalogue(offset=>request('https://api.bgm.tv/v0/episodes?subject_id='+encodeURIComponent(key)+'&limit=100&offset='+offset)).catch(error=>{catalogueCache.delete(key);throw error;});catalogueCache.set(key,pending);}return catalogueCache.get(key);}
let virtualGrid;
function disposeLibrary(){smoothScroller.cancel();virtualGrid?.destroy();virtualGrid=null;imageObserver.disconnect();}
let noticeTimer;
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
function button(text,action,cls='button small'){const el=node('button',cls,text);el.type='button';el.onclick=action;return el;}
function notice(message){clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').hidden=false;noticeTimer=setTimeout(()=>{$('#notice').hidden=true;},7000);}
function works(){return Object.entries(state.data).filter(([id,w])=>/^WorkSaveNo\d+$/.test(id)&&w?.ExistCondition==='Exist').map(([id,w])=>({id,...w}));}
function slots(work){return Object.entries(work.EPDetails||{}).sort((a,b)=>(a[1].LocalIndex||0)-(b[1].LocalIndex||0));}
function progress(work){const list=slots(work);const watched=list.filter(([,s])=>s.Condition==='Watched').length;return {total:list.length,watched,percent:list.length?Math.round(watched/list.length*100):0};}
function resources(work){return [...(work.RenameBinding?.resources||[]),...Object.values(work.SPDetails||{}).map(s=>({path:s.AbsolutePath||path.resolve(work.URL,s.URL),type:1}))];}
function invalid(work){return work.RenameBinding?.invalidResources||[];}
function coverURL(work){const url=work.DisplayCover||work.Cover||'';if(/^(file:|https?:|\.\/)/.test(url))return url;return path.isAbsolute(url)?pathToFileURL(url).href:'./assets/no_img.gif';}
function setDetailBackdrop(work){
  const backdrop=$('.app-backdrop');
  let poster=backdrop.querySelector('img');
  if(!work){poster?.remove();return;}
  const url=coverURL(work);
  if(url.endsWith('/no_img.gif')){poster?.remove();return;}
  if(!poster){poster=node('img','detail-backdrop-poster');poster.alt='';poster.decoding='async';poster.onerror=()=>poster.remove();backdrop.appendChild(poster);}
  if(poster.getAttribute('src')!==url)poster.src=url;
}
function image(work,cls){const el=node('img',cls);el.dataset.source=coverURL(work);el.alt='';el.decoding='async';el.onerror=()=>{el.onerror=null;el.src='./assets/no_img.gif';};imageObserver.observe(el);return el;}
async function request(url){if(apiCache.has(url))return apiCache.get(url);const pending=ipc.invoke('bangumi:request',{url}).then(response=>{if(response.error||response.status!==200)throw Error(response.error||'Bangumi 暂时不可用');return JSON.parse(response.body);});apiCache.set(url,pending);try{return await pending;}catch(error){apiCache.delete(url);throw error;}}
function adopt(data){state.data=data;const all=works();$('#library-count').textContent=all.length;$('#issue-count').textContent=all.reduce((n,w)=>n+invalid(w).length,0)||'';const chosen=$('#year').value;$('#year').replaceChildren(new Option('全部年份',''));[...new Set(all.map(w=>String(w.Year)).filter(y=>/^\d{4}$/.test(y)&&y!=='0000'))].sort().reverse().forEach(y=>$('#year').add(new Option(y+' 年',y)));$('#year').value=chosen;const selected=$('#media-type').value;$('#media-type').replaceChildren(new Option('全部类型',''));for(const type of ['TV','剧场版','OVA','OAD','WEB','其他'])if(all.some(w=>mediaType(w)===type))$('#media-type').add(new Option(type,type));$('#media-type').value=selected;}
async function read(){adopt(await ipc.invoke('library:read'));}
async function edit(work,changes){if(state.busy)return false;state.busy=true;try{const updated=await ipc.invoke('library:edit',{id:work.id,changes});state.data[work.id]=updated;return true;}catch(error){notice('保存失败：'+error.message);return false;}finally{state.busy=false;}}
async function openFile(file){try{const stat=await fs.promises.stat(file);if(stat.isFile()&&!stat.size)throw Error('这是空文件，无法打开');const error=await shell.openPath(file);if(error)throw Error(error);}catch(error){notice('无法打开：'+error.message);}}
function reveal(file){try{shell.showItemInFolder(file);}catch(error){notice(error.message);}}
function setHeader(title,subtitle,eyebrow='COLLECTION'){$('#page-title').textContent=title;$('#page-subtitle').textContent=subtitle;$('#breadcrumb').textContent=eyebrow;}
function activate(view){state.view=view;state.id=null;state.selected=null;state.token++;$('#notice').hidden=true;for(const item of document.querySelectorAll('[data-nav]'))item.classList.toggle('active',item.dataset.nav===view);$('#toolbar').hidden=!['library','watching'].includes(view);$('#scan-subtitles').hidden=!['library','watching'].includes(view);$('#filters').hidden=!['library','watching'].includes(view);$('#content').scrollTop=0;render();}
const organizerUI=require('./js/organizer-desktop.cjs').create({ipc,node,button,notice,setHeader,container:()=>$('#content'),isActive:()=>state.view==='organizer'});
const subtitlePanel=require('./js/subtitle-panel.cjs').create({ipc,node,button,notice,refresh:read});
function render(){if(state.view!=='detail')setDetailBackdrop(null);disposeLibrary();document.body.dataset.view=state.view;if(state.view==='organizer')organizerUI.render();else if(state.view==='detail')renderDetail();else if(state.view==='issues')renderIssues();else if(state.view==='settings')renderSettings();else renderLibrary();}
function renderLibrary(){
  disposeLibrary();
  const all=works();const watching=state.view==='watching';setHeader(watching?'正在观看':'媒体库',watching?'把正在追的故事接着看下去。':all.length+' 部本地番剧，章节、特典与观看进度集中管理。');
  const list=all.filter(w=>{const p=progress(w);if(watching&&!(p.watched>0&&p.watched<p.total))return false;if(state.query&&!String(w.Name).toLocaleLowerCase().includes(state.query.toLocaleLowerCase()))return false;if(state.year&&String(w.Year)!==state.year)return false;if(state.type&&mediaType(w)!==state.type)return false;if(state.subtitle&&(w.SubtitleSummary?.status||'unknown')!==state.subtitle)return false;return state.filter==='unwatched'?p.watched===0:state.filter==='watching'?p.watched>0&&p.watched<p.total:state.filter==='watched'?p.total>0&&p.watched===p.total:state.filter==='extras'?resources(w).length>0:true;});
  list.sort((a,b)=>state.sort==='year'?compareAirDates(a,b):state.sort==='score'?Number(b.Score)-Number(a.Score):state.sort==='progress'?progress(b).percent-progress(a).percent:String(a.Name).localeCompare(b.Name,'zh-CN',{numeric:true}));
  const filters=$('#filters');filters.replaceChildren();for(const [id,label]of [['all','全部'],['unwatched','未看'],['watching','在看'],['watched','已看'],['extras','有特典']])filters.appendChild(button(label,()=>{state.filter=id;renderLibrary();},'filter-chip'+(state.filter===id?' active':'')));filters.appendChild(node('span','filter-total',list.length+' 部作品'));
  $('#grid-view').classList.toggle('active',state.mode==='grid');$('#list-view').classList.toggle('active',state.mode==='list');
  const grid=node('div',state.mode==='grid'?'library-grid virtual-poster-grid':'library-list');
  $('#content').replaceChildren(grid);$('#content').scrollTop=0;
  if(!list.length){empty($('#content'),'没有找到作品','试试其他关键词或筛选条件。');return;}
  if(state.mode==='grid'){
    virtualGrid=require('./js/virtual-poster-grid.cjs').mount({root:grid,viewport:$('#content'),items:list,renderItem:posterCard,window,ResizeObserver,
      releaseItem:row=>{for(const img of row.querySelectorAll('img')){imageObserver.unobserve(img);img.removeAttribute('src');}}
    });
  }else{
    const fragment=document.createDocumentFragment();
    for(const work of list){const p=progress(work);const row=button('',()=>openDetail(work.id),'list-work');row.appendChild(image(work));const name=node('div');name.appendChild(node('strong','',work.Name));name.appendChild(node('small','',work.Year+' · '+work.Type));name.appendChild(node('small','',summaryLabel(work.SubtitleSummary)));row.append(name,node('span','',p.watched+' / '+p.total+' 集'),node('span','',resources(work).length+' 个特典'),node('span','',Number(work.Score)>0?'★ '+work.Score:'暂无评分'));fragment.appendChild(row);}
    grid.appendChild(fragment);
  }
}
function posterCard(work){
  const p=progress(work),card=node('article','work-card');
  const link=button('',()=>openDetail(work.id),'poster-link');link.setAttribute('aria-label','查看 '+work.Name);
  const poster=node('div','poster');poster.appendChild(image(work));
  if(Number(work.Score)>0)poster.appendChild(node('span','score-badge','★ '+work.Score));
  const bar=node('div','poster-progress'),fill=node('span');fill.style.width=p.percent+'%';bar.appendChild(fill);poster.appendChild(bar);link.appendChild(poster);card.appendChild(link);
  const title=node('div','work-title',work.Name);title.title=work.Name;card.appendChild(title);
  const meta=node('div','work-meta');meta.append(node('span','',work.Year==='0000'?'年份未知':work.Year),node('span','','· '+(work.Type||'动画')),node('span','progress-label',p.watched+' / '+p.total+' 集'));card.appendChild(meta);const sub=node('div','subtitle-card-status',summaryLabel(work.SubtitleSummary));sub.title='正片任一版本有字幕即计入；画面内嵌需手动确认';card.appendChild(sub);return card;
}

function empty(container,title,description){const el=node('div','empty-state');el.append(node('strong','',title),node('div','',description));container.appendChild(el);}
function returnToLibrary(){activate('library');$('#content').scrollTop=state.libraryScroll||0;}
function openDetail(id){if(['library','watching'].includes(state.view))state.libraryScroll=$('#content').scrollTop;state.id=id;state.view='detail';state.tab='chapters';state.selected=null;state.specialEpisodeId=null;state.token++;$('#toolbar').hidden=true;$('#scan-subtitles').hidden=true;$('#filters').hidden=true;$('#notice').hidden=true;$('#content').scrollTop=0;renderDetail();}
function activeWork(){return state.data[state.id]?{id:state.id,...state.data[state.id]}:null;}
function renderDetail(){
  disposeLibrary();
  document.body.dataset.view='detail';
  const work=activeWork();if(!work){activate('library');return;}
  setDetailBackdrop(work);
  const p=progress(work);setHeader('番剧详情','管理本地章节与文件','LIBRARY / DETAILS');const content=$('#content');const scroll=content.scrollTop;content.replaceChildren();
  const hero=node('section','detail-hero');hero.appendChild(image(work,'detail-cover'));const info=node('div','detail-info');info.appendChild(node('h2','',work.Name));const alias=node('div','alias','');alias.id='detail-alias';info.appendChild(alias);const meta=node('div','detail-meta');meta.append(node('span','',work.Type||'动画'),node('span','',airDateLabel(work)),node('span','',p.total+' 个正片章节'),node('span','',resources(work).length+' 个特典文件'));if(Number(work.Score)>0)meta.appendChild(node('span','rating','★ '+work.Score));info.appendChild(meta);
  const actions=node('div','detail-actions');actions.append(button('打开文件夹',()=>openFile(work.URL),'button primary small'),button('Bangumi ↗',()=>shell.openExternal('https://bgm.tv/subject/'+work.bgmID)),button('编辑信息',()=>renderEdit(work)),button('导入字幕',()=>{state.tab='subtitles';renderDetail();}));info.appendChild(actions);const line=node('div','detail-progress'),bar=document.createElement('progress');bar.max=Math.max(p.total,1);bar.value=p.watched;line.append(bar,node('span','',p.watched+' / '+p.total+' 集已看 · '+p.percent+'%'));info.appendChild(line);hero.appendChild(info);content.appendChild(hero);
  const relations=node('div','relation-strip');relations.hidden=true;content.appendChild(relations);
  const tabs=node('div','detail-tabs');for(const [id,label,count]of [['chapters','章节',p.total],['specials','特别章节','…'],['extras','特典文件',resources(work).length],['invalid','异常文件',invalid(work).length],['subtitles','字幕',work.SubtitleSummary?.covered||0]]){const tab=button(label,()=>{state.tab=id;state.selected=null;renderDetail();},'detail-tab'+(state.tab===id?' active':''));tab.dataset.detailTab=id;tab.appendChild(node('span','',count));tabs.appendChild(tab);}content.appendChild(tabs);
  const panel=node('div','detail-panel');content.appendChild(panel);
  if(state.tab==='specials')renderSpecialChapters(panel,work);else if(state.tab==='subtitles')subtitlePanel.mount(work,panel);else if(state.tab==='chapters')renderChapters(panel,work);else if(state.tab==='extras')renderResources(panel,work);else renderInvalid(panel,work);
  if(work.LocalNotes)content.appendChild(node('p','inline-note','备注：'+work.LocalNotes));content.scrollTop=scroll;
  const token=state.token;
  if(work.bgmID){episodeCatalogue(work.bgmID).then(rows=>{if(token!==state.token||!tabs.isConnected)return;const count=specialChapters(work,rows).reduce((n,g)=>n+g.rows.length,0);tabs.querySelector('[data-detail-tab="specials"] span').textContent=count;}).catch(()=>{if(tabs.isConnected)tabs.querySelector('[data-detail-tab="specials"] span').textContent='?';});request('https://api.bgm.tv/v0/subjects/'+work.bgmID).then(data=>{if(token!==state.token||!alias.isConnected)return;alias.textContent=data.name===work.Name?'':data.name||'';}).catch(()=>{});
    request('https://api.bgm.tv/v0/subjects/'+work.bgmID+'/subjects').then(rows=>{if(token!==state.token||!relations.isConnected||!Array.isArray(rows))return;for(const relation of rows){if(relation.type!==2)continue;const local=works().find(w=>String(w.bgmID)===String(relation.id));const item=button((relation.relation||'关联')+' · '+(relation.name_cn||relation.name),()=>local?openDetail(local.id):shell.openExternal('https://bgm.tv/subject/'+relation.id),'relation'+(local?' local':''));if(local)item.appendChild(node('span','local-tag','本地'));relations.appendChild(item);}relations.hidden=!relations.childElementCount;}).catch(()=>{});
  }
}
function renderChapters(panel,work){
  const heading=node('div','section-heading');heading.append(node('h3','','正片章节'),button('全部标为看过',async()=>{const changes=Object.fromEntries(slots(work).map(([key])=>['EPDetails.'+key+'.Condition','Watched']));if(await edit(work,changes))renderDetail();},'button quiet small'));panel.appendChild(heading);
  const grid=node('div','chapter-grid');const tiles=new Map();
  for(const [key,slot]of slots(work)){
    const watched=slot.Condition==='Watched';
    const tile=chapterCard({label:'EP '+(slot.EpisodeNumber||slot.LocalIndex),title:episodeNames.get(String(slot.EpisodeID))||(slot.Versions?.length||1)+' 个本地文件 · '+(watched?'已看':'未看'),
      status:watched?'✓':'',watched,selected:state.selected===key,
      onSelect:()=>{state.selected=key;for(const [id,el]of tiles)el.classList.toggle('selected',id===key);renderSelection(panel,work,key);panel.querySelector('.file-panel')?.scrollIntoView({block:'nearest'});},
      actions:chapterActions(work,key,'chapter-actions')});
    grid.appendChild(tile);tiles.set(key,tile);
  }
  panel.appendChild(grid);
  if(!slots(work).length)empty(panel,'暂无正片章节',work.BDMV==='BDMV'?'此作品为原盘，请通过“打开文件夹”管理。':'本地章节会随重命名产物导入。');
  if(state.selected)renderSelection(panel,work,state.selected);
  const token=state.token;if(work.bgmID&&slots(work).some(([,s])=>s.EpisodeID)){
    (async()=>{const rows=await episodeCatalogue(work.bgmID);if(token!==state.token||!grid.isConnected)return;const byId=new Map(rows.map(row=>[String(row.id),row]));for(const [key,slot]of slots(work)){const row=byId.get(String(slot.EpisodeID));if(!row)continue;const name=row.name_cn||row.name||'';episodeNames.set(String(row.id),name);const full=panel.querySelector('.selected-chapter-title');if(full?.dataset.episodeId===String(row.id))full.textContent=name;const tile=tiles.get(key),label=tile.querySelector('.chapter-name');label.textContent=row.name_cn||row.name||label.textContent;tile.title=row.name_cn||row.name||'';}})().catch(()=>{});
  }
}
function renderSpecialChapters(panel,work){
  const token=state.token;
  if(!work.bgmID){empty(panel,'尚未绑定 Bangumi 条目','绑定条目后才能获取特别章节目录。');return;}
  panel.appendChild(node('p','inline-note','正在读取 Bangumi 完整章节目录…'));
  episodeCatalogue(work.bgmID).then(rows=>{
    if(token!==state.token||!panel.isConnected)return;
    const groups=specialChapters(work,rows);
    function draw(){
      if(!panel.isConnected)return;const scroll=$('#content').scrollTop;panel.replaceChildren();
      panel.appendChild(node('p','inline-note','按 Bangumi 的章节类型独立展示，仅按明确章节 ID 匹配本地文件。未映射不代表没有下载，也可能是已有特典尚未绑定。'));
      if(!groups.length){empty(panel,'此条目没有特别章节','本地特典仍可在“特典文件”中查看。');return;}
      for(const group of groups){
        const section=node('section','special-catalog-section'),heading=node('div','section-heading');heading.append(node('h3','',group.title),node('span','',group.rows.length+' 个章节'));section.appendChild(heading);
        const grid=node('div','chapter-grid');
        for(const episode of group.rows){
          const selected=String(state.specialEpisodeId)===String(episode.id),watched=specialWatched(work,episode.id);
          const title=episode.name_cn||episode.name||'未命名章节';
          const tile=chapterCard({label:group.code+' '+(episode.sort??episode.ep??''),title,watched,selected,
            status:episode.state==='unmapped'?'未映射':episode.state==='unavailable'?'不可用':watched?'✓':episode.files.length+' 文件',
            warning:episode.state!=='mapped',onSelect:()=>{state.specialEpisodeId=selected?null:episode.id;draw();},
            actions:specialActions(work,group,episode,'chapter-actions')});
          tile.title=title+'\n'+(episode.state==='unmapped'?'未映射本地文件':episode.state==='unavailable'?'已映射，文件不可用':'已映射 '+episode.files.length+' 个文件')+(episode.airdate?'\n'+episode.airdate:'');grid.appendChild(tile);
        }
        const selected=group.rows.find(row=>String(row.id)===String(state.specialEpisodeId));
        if(selected){const box=episodeFilePanel({heading:group.code+' '+(selected.sort??selected.ep??'')+' · 本地文件',title:selected.name_cn||selected.name||'',episodeId:selected.id,
          actions:specialActions(work,group,selected,'file-panel-actions'),files:selected.files.map(file=>({path:file.path,description:file.availability&&file.availability!=='available'?'已映射，文件状态：'+file.availability:'已映射本地文件'})),
          emptyMessage:'未映射本地文件；已有未绑定资源可在“特典文件”中查看。',work});section.appendChild(box);}
        section.appendChild(grid);
        panel.appendChild(section);
      }
      $('#content').scrollTop=scroll;
    }
    draw();
  }).catch(error=>{if(token!==state.token||!panel.isConnected)return;panel.replaceChildren();empty(panel,'特别章节目录加载失败',error.message);panel.appendChild(button('重试',()=>renderSpecialChapters(panel,work),'button quiet'));});
}
function chapterCard({label,title,status='',watched=false,selected=false,warning=false,onSelect,actions}){
  const tile=node('article','chapter'+(watched?' watched':'')+(selected?' selected':'')+(warning?' mapping-warning':''));
  const main=button('',onSelect,'chapter-main');main.setAttribute('aria-label',label+' 章节文件');
  const top=node('div','chapter-top');top.append(node('span','',label),node('span','chapter-state',status));main.append(top,node('div','chapter-name',title));tile.append(main,actions);return tile;
}
function episodeActions({file,link,watched,onToggle,onThrough,throughTitle},cls){
  const actions=node('div',cls),play=button('▶ 播放',()=>openFile(file),'chapter-action play');play.disabled=!file;play.title=file?'使用系统播放器打开本集':'未映射可用的本地文件';
  const comments=button('评论 ↗',()=>shell.openExternal(link),'chapter-action');comments.disabled=!link;comments.title=link?'在浏览器打开本集 Bangumi 评论':'此集尚未绑定 Bangumi 单集';
  const seen=button(watched?'撤销已看':'看过',onToggle,'chapter-action'),through=button('看到这里',onThrough,'chapter-action');through.title=throughTitle;
  actions.append(play,comments,seen,through);return actions;
}
function chapterActions(work,key,cls){
  const slot=work.EPDetails[key];return episodeActions({file:episodePath(work,slot),link:episodeLink(slot),watched:slot.Condition==='Watched',
    onToggle:async()=>{if(await edit(work,{['EPDetails.'+key+'.Condition']:slot.Condition==='Watched'?'Unwatched':'Watched'}))renderDetail();},
    onThrough:async()=>{if(await edit(work,watchedThrough(work,key)))renderDetail();},throughTitle:'将本集及之前的正片全部标为看过，后面的集数保持原样'},cls);
}
function specialActions(work,group,episode,cls){return episodeActions({file:episode.usable[0]?.path,link:'https://bgm.tv/ep/'+episode.id,watched:specialWatched(work,episode.id),
  onToggle:async()=>{if(await edit(work,specialToggle(work,episode.id)))renderDetail();},
  onThrough:async()=>{if(await edit(work,specialThrough(group,episode.id)))renderDetail();},throughTitle:'将本章节及之前的'+group.title+'标为看过，保留其他类型与正片进度'},cls);}
function episodeFilePanel({heading,title,episodeId,actions,files,emptyMessage,work}){
  const box=node('section','file-panel'),header=node('div','file-panel-header');header.append(node('h3','',heading),actions);box.appendChild(header);
  const name=node('p','selected-chapter-title',title);name.dataset.episodeId=String(episodeId||'');box.appendChild(name);
  if(!files.length&&emptyMessage)box.appendChild(node('p','inline-note',emptyMessage));
  for(const file of files)if(file.path)box.appendChild(fileRow(file.path,file.description,work));return box;
}
function renderSelection(panel,work,key){
  panel.querySelector('.file-panel')?.remove();const slot=work.EPDetails[key];if(!slot)return;
  const box=episodeFilePanel({heading:'EP '+(slot.EpisodeNumber||slot.LocalIndex)+' · 本地文件',title:episodeNames.get(String(slot.EpisodeID))||'',episodeId:slot.EpisodeID,
    actions:chapterActions(work,key,'file-panel-actions'),files:slot.Versions||[{path:episodePath(work,slot)}],work});
  panel.insertBefore(box,panel.querySelector('.chapter-grid'));
}
async function clearRecords(selection){
  if(state.busy)return;state.busy=true;
  try{const result=await ipc.invoke('library:clear-records',selection);adopt(result.data);state.token++;state.selected=null;render();notice('已清除 '+result.cleared+' 条异常记录，磁盘文件未删除。');}
  catch(error){notice('清除失败：'+error.message);}finally{state.busy=false;}
}
async function trashFile(work,file){
  if(state.busy)return;state.busy=true;
  try{const result=await ipc.invoke('library:trash-file',{id:work.id,path:file});if(result.cancelled)return;adopt(result.data);state.token++;state.selected=null;render();notice(result.warning||'文件已移入回收站，对应记录已更新。');}
  catch(error){notice('删除操作未完成：'+error.message);}finally{state.busy=false;}
}
function fileRow(file,description,work=activeWork()){
  const row=node('div','file-row'),label=node('div','file-name',path.basename(file));label.title=file;if(description)label.appendChild(node('small','',description));
  const actions=node('div','file-actions'),remove=button('删除文件',()=>trashFile(work,file),'button danger small');
  remove.disabled=!work?.RenameBinding?.files?.some(row=>path.resolve(row.path).toLowerCase()===path.resolve(file).toLowerCase());remove.title='确认后移入系统回收站';
  actions.append(button('打开',()=>openFile(file)),button('定位',()=>reveal(file),'button quiet small'),remove);row.append(label,actions);return row;
}
function renderResources(panel,work){const files=resources(work);const heading=node('div','section-heading');heading.append(node('h3','','特典文件'),node('small','',files.length+' 个文件'));panel.appendChild(heading);if(invalid(work).length)panel.appendChild(node('p','inline-note',invalid(work).length+' 个空文件或失效文件已排除，可在“异常文件”查看。'));if(!files.length){empty(panel,'没有有效的特典文件','SP、NCOP、NCED、CM 等均在此管理。');return;}const list=node('div','resource-list');for(const file of files)list.appendChild(fileRow(file.path,file.type===1?'SP / 特别篇':'特典'));panel.appendChild(list);}
function renderInvalid(panel,work){
  const files=invalid(work);const heading=node('div','section-heading');heading.append(node('h3','','异常记录 · '+files.length));
  const clear=button('清除本番记录',()=>clearRecords({id:work.id,paths:files.map(file=>file.path)}),'button quiet small');clear.disabled=!files.length;heading.appendChild(clear);panel.appendChild(heading);
  panel.appendChild(node('p','inline-note','清除记录只修改索引，不删除磁盘文件；删除文件需确认，并移入系统回收站。'));
  if(!files.length){empty(panel,'没有异常文件','已登记的文件状态正常。');return;}
  const list=node('div','resource-list');
  for(const file of files){
    const row=node('div','file-row'),name=node('div','file-name',path.basename(file.path));name.title=file.path;
    const actions=node('div','file-actions'),remove=button('删除文件',()=>trashFile(work,file.path),'button danger small');remove.disabled=file.availability==='missing';remove.title='确认后移入系统回收站';
    actions.append(button('定位',()=>reveal(file.path),'button quiet small'),button('清除记录',()=>clearRecords({id:work.id,paths:[file.path]}),'button quiet small'),remove);
    row.append(name,node('span','issue-label',file.availability==='empty'?'0 字节 / 空文件':file.availability==='missing'?'路径不存在':'无法读取'),actions);list.appendChild(row);
  }
  panel.appendChild(list);
}
function renderEdit(work){const panel=$('.detail-panel');panel.replaceChildren();const form=node('form','settings-card edit-form');form.appendChild(node('h3','','编辑本地信息'));const title=node('label','','显示名称'),input=node('input');input.value=work.Name;input.required=true;title.appendChild(input);const notes=node('label','','本地备注'),textarea=node('textarea');textarea.value=work.LocalNotes||'';notes.appendChild(textarea);const actions=node('div','form-actions'),save=button('保存',null,'button primary');save.type='submit';actions.append(save,button('取消',renderDetail,'button quiet'));form.append(title,notes,node('p','inline-note','只修改媒体库显示信息，文件名保持不变。'),actions);form.onsubmit=async event=>{event.preventDefault();if(await edit(work,{Name:input.value.trim(),LocalNotes:textarea.value}))renderDetail();};panel.appendChild(form);input.focus();}
function renderIssues(){
  const all=works().filter(work=>invalid(work).length),count=all.reduce((n,work)=>n+invalid(work).length,0);
  setHeader('异常文件',count+' 个文件已排除，正常章节与特典不受影响。','LIBRARY HEALTH');const content=$('#content');content.replaceChildren();
  const heading=node('div','section-heading');heading.appendChild(node('h3','','异常记录管理'));
  const clear=button('清除全部异常记录',()=>clearRecords({all:true}),'button quiet small');clear.disabled=!count;heading.appendChild(clear);content.appendChild(heading);
  if(!all.length){empty(content,'没有异常文件','出现异常记录后，可在这里逐条清除、批量清除，或将文件移入回收站。');return;}
  for(const work of all){const section=node('section','issue-work');section.appendChild(button(work.Name,()=>{openDetail(work.id);state.tab='invalid';renderDetail();},'button quiet issue-work-title'));renderInvalid(section,work);content.appendChild(section);}
}
function renderSettings(){setHeader('偏好设置','简化浏览，保留你的管理习惯。','PREFERENCES');const content=$('#content');content.replaceChildren();const display=node('section','settings-card');display.appendChild(node('h3','','媒体库显示'));const row=node('div','settings-row');row.append(node('span','','默认浏览方式'));const modes=node('div','form-actions');for(const [id,label]of [['grid','海报视图'],['list','列表视图']])modes.appendChild(button(label,()=>{state.mode=id;localStorage.setItem('library-view',id);renderSettings();},'button '+(state.mode===id?'primary':'quiet')));row.appendChild(modes);display.appendChild(row);content.appendChild(display);
  const appearanceCard=node('section','settings-card');
  appearanceCard.append(node('h3','','外观'),node('p','','淡化背景搭配深色面板；毛玻璃用于侧栏和悬浮按钮。设置自动保存。'));
  for(const [key,label] of [['background','背景图片'],['glass','毛玻璃效果']]){
    const row=node('label','settings-row'),toggle=node('input','appearance-toggle');
    toggle.type='checkbox';toggle.checked=appearance[key];
    toggle.onchange=()=>{appearance[key]=toggle.checked;localStorage.setItem('appearance-'+key,toggle.checked?'on':'off');applyAppearance();};
    row.append(node('span','',label),toggle);appearanceCard.appendChild(row);
  }
  content.appendChild(appearanceCard);
  const tools=node('section','settings-card');tools.append(node('h3','','资源整理'),node('p','','添加来源、审核方案、执行入库与整理设置集中在资源整理页面。'),button('打开资源整理',()=>activate('organizer'),'button quiet'));content.appendChild(tools);
  const storage=node('section','settings-card');storage.appendChild(node('h3','','数据存储'));content.appendChild(storage);ipc.invoke('library:storage').then(info=>{if(storage.isConnected){storage.append(node('p','','管理数据：'+info.directory),node('p','','整理记录：'+info.renameData));}}).catch(error=>notice(error.message));
  const health=node('section','settings-card');health.append(node('h3','','文件状态'),node('p','',works().reduce((n,w)=>n+invalid(w).length,0)+' 个异常文件已从有效列表排除；原文件保留。'),button('查看异常文件',()=>activate('issues'),'button quiet'));content.appendChild(health);
}
for(const item of document.querySelectorAll('[data-nav]'))item.onclick=()=>activate(item.dataset.nav);
$('#library-back').onclick=returnToLibrary;
function jumpContent(bottom){smoothScroller.cancel();const viewport=$('#content');viewport.scrollTo({top:bottom?Math.max(0,viewport.scrollHeight-viewport.clientHeight):0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
$('#scroll-top').onclick=()=>jumpContent(false);
$('#scroll-bottom').onclick=()=>jumpContent(true);
let searchTimer;$('#search').oninput=event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(renderLibrary,120);};
$('#media-type').onchange=event=>{state.type=event.target.value;renderLibrary();};
$('#subtitle-filter').onchange=event=>{state.subtitle=event.target.value;renderLibrary();};
$('#scan-subtitles').onclick=async()=>{try{const progress=await ipc.invoke('subtitles:scan-all');showSubtitleProgress(progress);}catch(error){notice(error.message);}};
function showSubtitleProgress(progress){const control=$('#scan-subtitles');control.disabled=progress.running;control.textContent=progress.running?'检测字幕 '+progress.done+'/'+progress.total:'检测全库字幕';if(!progress.running){read().then(()=>{if(['library','watching'].includes(state.view))render();}).catch(error=>notice(error.message));notice(progress.error||'字幕检测完成；画面内嵌仍需人工确认。');}}
ipc.on('subtitles:progress',(_event,progress)=>showSubtitleProgress(progress));
$('#year').onchange=event=>{state.year=event.target.value;renderLibrary();};$('#sort').value=state.sort;$('#sort').onchange=event=>{state.sort=event.target.value;localStorage.setItem('library-sort',state.sort);renderLibrary();};
for(const mode of ['grid','list'])$('#'+mode+'-view').onclick=()=>{state.mode=mode;localStorage.setItem('library-view',mode);renderLibrary();};
$('#refresh').onclick=async()=>{const control=$('#refresh');control.disabled=true;control.textContent='检查文件中…';try{if(state.view==='organizer'){await organizerUI.refresh();return;}const result=await ipc.invoke('library:recheck');adopt(result.data);apiCache.clear();catalogueCache.clear();state.token++;render();notice('已检查 '+result.report.checked+' 个文件'+(result.report.removed?'，清理 '+result.report.removed+' 条已删除的异常记录':'，文件状态已更新'));}catch(error){notice('刷新失败：'+error.message);}finally{control.disabled=false;control.textContent='↻ 刷新';}};
document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key.toLowerCase()==='k'){event.preventDefault();if(!['library','watching'].includes(state.view))activate('library');$('#search').focus();}if(event.key==='Escape'&&state.view==='detail'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName))returnToLibrary();});
ipc.on('library:updated',async()=>{await read();if(state.view==='detail')renderDetail();else if(state.view!=='organizer')render();});
ipc.on('MainWindow',(_event,action)=>{const view={OpenMediaPage:'library',OpenMainPage:'library',OpenWatchingPage:'watching',OpenOrganizerPage:'organizer',OpenSettingsPage:'settings'}[action];if(view)activate(view);});
ipc.invoke('subtitles:progress').then(progress=>{if(progress.running)showSubtitleProgress(progress);}).catch(()=>{});
read().then(render).catch(error=>{empty($('#content'),'无法读取媒体库',error.message);});
require('./js/desktop-performance.cjs').install({document,window});
