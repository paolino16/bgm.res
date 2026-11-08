'use strict';
function mount({ipc,node,button,notice,host,work,works=()=>[],onSelect}){
  const section=node('section','subtitle-inbox'),toolbar=node('div','subtitle-inbox-toolbar'),list=node('div','subtitle-inbox-list'),count=node('span','inline-note');list.hidden=true;
  const open=button('字幕收件箱',async()=>{list.hidden=!list.hidden;if(!list.hidden)await refresh();});
  toolbar.append(open,count);section.append(toolbar,list);host.append(section);
  let loading=false;
  async function refresh(){
    if(loading)return;loading=true;
    try{
      const items=(await ipc.invoke('subtitle-inbox:list')).filter(item=>item.state!=='cleaned');
      count.textContent=items.length?'待处理 '+items.length+' 个下载包':'收件箱为空';list.replaceChildren();
      if(!items.length)list.append(node('p','inline-note','下载后的字幕包会保留在这里，全部处理后自动清理。'));
      for(const item of items){
        const row=node('article','subtitle-inbox-row'),copy=node('div','subtitle-version-copy'),actions=node('div','organizer-actions');
        copy.append(node('strong','',item.name),node('small','','已导入 '+item.done+' / '+item.files.length+' · '+(item.error||item.warning||'剩余 '+item.remaining.length)));
        let selected=work?.id||item.workId;
        if(!work){const select=node('select');select.setAttribute('aria-label','下载包目标作品');select.add(new Option('选择作品',''));for(const value of works())select.add(new Option(value.Name,value.id));select.value=selected||'';select.onchange=()=>{selected=select.value;};copy.append(select);}
        function safe(fn){return async()=>{try{await fn();}catch(error){notice(error.message);}};}
        const next=button('继续导入',safe(async()=>{
          if(!selected)throw Error('请先选择目标作品');
          if(!item.remaining.length)throw Error('没有待导入字幕，请清理下载包');
          await ipc.invoke('subtitle-inbox:command',{id:item.id,command:'assign',workId:selected,workName:work?.Name||works().find(value=>value.id===selected)?.Name});
          await onSelect(item.remaining,selected);
        }));next.disabled=!item.remaining.length;
        if(work)next.title='将剩余 '+item.remaining.length+' 个字幕导入当前作品：'+work.Name+(item.workName?'；上次目标：'+item.workName:'');
        actions.append(next,button('打开下载目录',safe(()=>ipc.invoke('subtitle-sources:folder',item.folder))),button(item.state==='cleanup-failed'&&!item.remaining.length?'重试清理':'放弃剩余并清理',safe(async()=>{const result=await ipc.invoke('subtitle-inbox:command',{id:item.id,command:item.state==='cleanup-failed'&&!item.remaining.length?'clean':'discard'});if(result.error)notice(result.error);await refresh();})));
        row.append(copy,actions);list.append(row);
      }
    }catch(error){count.textContent='收件箱读取失败';if(!list.hidden)notice(error.message);}finally{loading=false;}
  }
  void refresh();return {refresh};
}
module.exports={mount};
