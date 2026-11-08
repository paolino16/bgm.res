'use strict';

function createFilePreview({ipc,node,button,formatSize}) {
  const cache=new Map();
  const bytes=size=>size===0?'0 B':formatSize(String(size));
  return function open(group, panel) {
    const row=group.find(hit=>hit.torrent) || group.find(hit=>hit.source==='nyaa') || group[0];
    const key=row.hash || row.page;
    const dialog=node('dialog','settings-card torrent-preview');
    dialog.setAttribute('aria-label','种子文件详情');
    const title=node('h3','',row.title),status=node('p','inline-note');
    status.setAttribute('role','status');
    const list=node('ul','torrent-files');
    const controls=node('div','organizer-actions');
    const close=button('关闭',()=>dialog.close(),'button quiet');
    dialog.append(title,status,list,controls);
    function onBackdrop(event) {
      if(event.target!==dialog)return false;
      const {left,right,top,bottom}=dialog.getBoundingClientRect();
      return event.clientX<left || event.clientX>=right || event.clientY<top || event.clientY>=bottom;
    }
    let pressedOutside=false;
    dialog.onpointerdown=event=>{pressedOutside=event.button===0 && onBackdrop(event);};
    dialog.onclick=event=>{
      if(pressedOutside && onBackdrop(event))dialog.close();
      pressedOutside=false;
    };
    dialog.onclose=()=>dialog.remove();
    panel.append(dialog);
    dialog.showModal();

    function display(data) {
      status.textContent=data.files.length+' 个文件 · '+bytes(data.size);
      let count=0;
      function more() {
        for(const file of data.files.slice(count,count+200)){
          const item=node('li');
          item.append(node('span','',file.path),node('span','torrent-file-size',bytes(file.size)));
          list.append(item);
          count++;
        }
        controls.replaceChildren();
        if(count<data.files.length)controls.append(button('显示更多文件',more,'button quiet'));
        controls.append(close);
      }
      more();
    }
    async function load() {
      if(cache.has(key)){display(cache.get(key));return;}
      status.textContent='正在获取种子文件清单…';
      controls.replaceChildren(close);
      const started=Date.now();
      const canFallback=row.hash && (row.torrent || row.source==='nyaa');
      let magnetOnly=false;
      try {
        while(dialog.open && dialog.isConnected) {
          let data;
          try { data=await ipc.invoke('resources:files',{row,magnetOnly}); }
          catch(error){
            if(!canFallback || magnetOnly)throw error;
            magnetOnly=true;continue;
          }
          if(!dialog.open || !dialog.isConnected)return;
          if(!data.pending){
            cache.set(key,data);
            if(cache.size>24)cache.delete(cache.keys().next().value);
            display(data);return;
          }
          const elapsed=Date.now()-started;
          if(elapsed>=45000)throw Error('暂时没有取得种子元数据，请稍后重试。');
          await new Promise(resolve=>setTimeout(resolve,1500));
        }
      } catch(error) {
        if(!dialog.open || !dialog.isConnected)return;
        status.textContent=error.message.includes('HTTP 404')?'当前 qBittorrent Web UI 不支持种子预览，请升级 qBittorrent。':error.message.replace(/^Error invoking remote method '[^']+': Error: /,'');
        controls.replaceChildren(button('重试',load,'button quiet'),close);
      }
    }
    void load();
  };
}
module.exports={createFilePreview};
