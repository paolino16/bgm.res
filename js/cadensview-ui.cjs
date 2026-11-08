'use strict';
function create({ipc,node,button,notice,shell}){
  const views=new Set();let snapshot=null;
  const describe=state=>{
    if(state.progress){const p=state.progress;if(p.phase==='extract')return '正在解压并验证更新包…';return '正在下载'+(p.total?' · '+Math.min(100,Math.floor(p.received/p.total*100))+'%':'')+' · '+Math.round((p.received||0)/1024/1024)+' MiB';}
    if(state.pending)return '新版 '+state.pending.version+' 已就绪，关闭 CadensView 后自动切换。';
    if(state.error)return state.error;
    if(state.checkError)return '检查更新失败：'+state.checkError+'。可以继续鉴赏，或稍后重试。';
    if(state.cleanupError)return state.cleanupError;
    if(state.latest&&require('./cadensview-main.cjs').newer(state.latest.version,state.version))return '发现新版 '+state.latest.version+'，下载后将保留旧版以便回退。';
    return state.latest?'已是最新版本。':'首次使用鉴赏时将自动检查更新，也可立即手动检查。';
  };
  function refresh(state){snapshot=state;for(const view of views){if(!view.root.isConnected){views.delete(view);continue;}view.update(state);}}
  ipc.on('cadensview:update',(_event,message)=>{
    if(message.event==='warning'){notice(message.message);return;}
    if(message.event==='progress'){if(snapshot)refresh({...snapshot,progress:message});return;}
    refresh(message);
    if(message.event==='checked'&&message.available)notice('CadensView 有新版 '+message.latest.version+'，可在偏好设置 → 单集鉴赏中下载更新。');
    if(message.event==='switched')notice('鉴赏程序已切换至 CadensView '+message.version+'。');
  });
  async function open(work,file){try{const result=await ipc.invoke('cadensview:open',{id:work.id,path:file});if(result.alreadyOpen)notice('本集已在 CadensView 中打开，请切换到鉴赏窗口。');}catch(error){notice('无法鉴赏：'+error.message);}}
  function settings(content){
    const root=node('section','settings-card cadensview-settings');content.appendChild(root);
    root.append(node('h3','','单集鉴赏 · CadensView'),node('p','','使用 CadensView 打开本地视频；已有项目由鉴赏程序自动恢复。'));
    const pathLabel=node('label','organizer-field'),input=node('input');input.type='text';input.readOnly=true;input.setAttribute('aria-label','CadensView 程序路径');pathLabel.append(node('span','','程序位置'),input);
    const choose=button('选择程序',()=>perform('cadensview:choose'),'button quiet');
    const pathRow=node('div','cadensview-path');pathRow.append(pathLabel,choose);root.append(pathRow);
    const autoLabel=node('label','settings-row'),automatic=node('input');automatic.type='checkbox';automatic.onchange=()=>perform('cadensview:configure',{automatic:automatic.checked});autoLabel.append(node('span','','每天首次鉴赏时自动检查更新'),automatic);root.append(autoLabel);
    const version=node('p',''),status=node('p','inline-note');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.append(version,status);
    const actions=node('div','form-actions');
    const check=button('检查更新',()=>perform('cadensview:check'),'button quiet'),install=button('下载更新',()=>perform('cadensview:install'),'button primary'),apply=button('切换新版',()=>perform('cadensview:apply'),'button quiet'),rollback=button('切换旧版',()=>perform('cadensview:rollback'),'button quiet');
    const release=button('发布页面',()=>shell.openExternal(snapshot?.latest?.url||'https://github.com/dddkkw/CadensView/releases'),'button quiet');actions.append(check,install,apply,rollback,release);root.append(actions);
    const details=node('details','cadensview-notes'),summary=node('summary','','更新说明'),notes=node('p','');details.append(summary,notes);root.append(details);
    root.append(node('p','inline-note','自动下载的程序滚动保留当前版和上一版，更早版本在切换成功后自动删除。等待切换时暂时保留新版；手动安装的目录和用户项目不参与清理。旧项目的兼容性以新版实际支持为准。'));
    let busy=false,current=null;
    function update(state){current=state;input.value=state.path;input.title=state.path;automatic.checked=state.automatic;version.textContent='当前版本：'+(state.version||'未知')+(state.latest?' · 最新版本：'+state.latest.version:'');status.textContent=describe(state);
      const downloading=Boolean(state.progress),locked=busy||downloading;
      choose.disabled=automatic.disabled=check.disabled=locked;install.hidden=!state.latest||!require('./cadensview-main.cjs').newer(state.latest.version,state.version)||Boolean(state.pending);install.disabled=locked;
      apply.hidden=!state.pending;apply.disabled=locked;rollback.hidden=!state.previous;rollback.disabled=locked;
      details.hidden=!state.latest?.notes;notes.textContent=state.latest?.notes||'';
    }
    async function perform(channel,body){if(busy)return;busy=true;let failure='';if(current)update(current);
      try{const result=await ipc.invoke(channel,body);if(result)refresh(result);if(channel==='cadensview:apply'&&result?.pending)notice('请先关闭 CadensView，随后会自动切换新版。');}
      catch(error){failure=error.message;status.textContent=failure;notice(failure);}
      finally{busy=false;try{const latest=await ipc.invoke('cadensview:status');if(root.isConnected){refresh(latest);if(failure)status.textContent=failure;}}catch{if(current)update(current);if(failure)status.textContent=failure;} }
    }
    const view={root,update};views.add(view);if(snapshot)update(snapshot);else{status.textContent='正在读取鉴赏设置…';choose.disabled=check.disabled=install.disabled=automatic.disabled=true;install.hidden=apply.hidden=rollback.hidden=details.hidden=true;}
    ipc.invoke('cadensview:status').then(refresh).catch(error=>{if(root.isConnected)status.textContent='无法读取鉴赏设置：'+error.message;});
    return root;
  }
  return {open,settings};
}
module.exports={create};
