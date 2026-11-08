'use strict';
function create({ipc,node,button,notice,setHeader,container,works,openSettings,openWork,match,returnToSearch}){
  const search=require('./subtitle-sources-ui.cjs').create({ipc,node,button,notice});
  let workId=null;
  function preset(work){workId=work?.id||null;}
  function render(){
    const work=workId?works().find(work=>work.id===workId):null;
    if(workId&&!work){workId=null;notice('目标作品已不在媒体库中，已切换到独立字幕搜索');}
    setHeader('字幕搜索',work?'为 '+work.Name+' 查找字幕，下载解压后识别并预览重命名。':'搜索论坛与射手网字幕，查看说明后下载。');
    const host=container();host.replaceChildren();
    const page=node('div','subtitle-search-page');host.appendChild(page);
    require('./subtitle-inbox-ui.cjs').mount({ipc,node,button,notice,host:page,work,works,onSelect:async(files,id)=>{const target=works().find(value=>value.id===id);if(!target)throw Error('作品已移除');await match(target,files);}});
    if(work){
      const context=node('div','subtitle-search-context'),copy=node('div');
      copy.append(node('span','inline-note','目标作品'),node('strong','',work.Name));
      const actions=node('div','organizer-actions');actions.append(button('返回作品',()=>openWork(work)),button('独立搜索',()=>{preset(null);render();},'button quiet small'));
      context.append(copy,actions);page.appendChild(context);
    }
    search.mount(work||{id:'standalone',Name:''},page,{heading:false,onSettings:openSettings,
      onSelect:work?async files=>{
        const current=works().find(item=>item.id===work.id);
        if(!current)throw Error('目标作品已不在媒体库中，请重新选择作品');
        await match(current,files);
      }:null});
  }
  return {render,preset,settings:host=>search.settings(host,{onReturn:returnToSearch}),focus:search.focus};
}
module.exports={create};
