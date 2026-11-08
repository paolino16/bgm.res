'use strict';

const stages = {waiting:'等待在 qBit 中添加',unconfirmed:'尚未添加到 qBit',missing:'qBit 中未找到此任务',complete:'已下载 · 未入库',
  recognizing:'后台识别中 · 未入库',ready:'识别完成 · 正在确认入库状态',failed:'识别需处理 · 未确认入库'};
const libraryStates={pending:'待审核入库',imported:'已入库',cancelled:'已放弃方案 · 未入库',
  failed:'整理需处理',missing:'整理任务已移除 · 无法确认入库',unknown:'入库状态待确认'};
const states = {downloading:'下载中',forcedDL:'强制下载中',stalledDL:'等待连接',queuedDL:'排队中',
  pausedDL:'已暂停',stoppedDL:'已停止',checkingDL:'校验中',checkingUP:'校验中',checkingResumeData:'校验中',
  moving:'正在移动文件',metaDL:'获取元数据',forcedMetaDL:'获取元数据',allocating:'分配空间',
  error:'qBit 下载出错',missingFiles:'下载文件缺失'};

function remainingTime(row) {
  // qBittorrent uses 100 days as the sentinel for an unknown ETA.
  if (!['downloading','forcedDL'].includes(row.state) || !(row.speed>0) ||
      !(row.progress<1) || !Number.isFinite(row.eta) || row.eta<0 || row.eta>=8640000)
    return '预估剩余时间未知';
  if (row.eta<1) return '预估剩余不到 1秒';
  const seconds=Math.ceil(row.eta);
  const units=[[86400,'天'],[3600,'小时'],[60,'分'],[1,'秒']];
  let rest=seconds;
  const parts=[];
  for (const [size,label] of units) {
    const count=Math.floor(rest/size);
    rest%=size;
    if(count)parts.push(count+label);
    if(parts.length===2)break;
  }
  return '预估剩余 '+parts.join(' ');
}

function downloads({ipc,node,button,notice,openTask,openSettings,container,setHeader}) {
  function list(host) {
    let last,timer;
    async function refresh() {
      if (!host.isConnected || host.hidden) return;
      try {
        const data=await ipc.invoke('downloads:list');
        if (!host.isConnected || host.hidden) return;
        const version=JSON.stringify(data);
        if (last!==version) {
          last=version;
          host.replaceChildren();
          if (data.error) host.append(node('p','inline-note',data.error),button('连接设置',openSettings,'button quiet small'));
          if (data.rows.some(row=>row.stage==='unconfirmed')) host.append(button('清理未添加记录',async()=>{
            try {await ipc.invoke('downloads:command',{command:'clear-unconfirmed'});last=null;void refresh();}
            catch(error){notice(error.message);}
          },'button quiet small'));
          if (!data.rows.length) host.append(node('p','inline-note','还没有从资源搜索发起的下载。'));
          for (const row of data.rows) {
            const entry=node('article','resource-row'),info=node('div','resource-info');
            const label=libraryStates[row.libraryStatus] || stages[row.stage] || states[row.state] || row.state || '等待更新';
            const meta=[label];
            if (row.stage==='downloading' && Number.isFinite(row.progress)) {
              meta.push((row.progress*100).toFixed(1)+'%');
              meta.push(row.speed>=1048576?(row.speed/1048576).toFixed(1)+' MiB/s':Math.round((row.speed||0)/1024)+' KiB/s');
              meta.push(remainingTime(row));
            }
            if(row.error && (!row.libraryStatus || row.libraryStatus==='unknown'))meta.push(row.error);
            if(row.libraryError && row.libraryError!==row.error)meta.push(row.libraryError);
            if(row.stage==='waiting')meta.push('请在 qBit 添加窗口确认；取消后可移除记录');
            if(row.stage==='unconfirmed')meta.push('可能已取消添加或磁力尚未解析，可移除记录；稍后添加仍会自动跟踪');
            if(row.libraryStatus==='pending')meta.push('审核方案并执行入库后，媒体库才会更新');
            info.append(node('div','resource-title',row.title),node('div','resource-meta',meta.join(' · ')));
            const actions=node('div','resource-actions');
            const command=async cmd=>{
              try {await ipc.invoke('downloads:command',{hash:row.hash,command:cmd});last=null;void refresh();}
              catch(error){notice(error.message);}
            };
            if (row.taskId && row.libraryStatus!=='missing') actions.append(button(row.libraryStatus==='pending'?'审核并入库':'查看整理任务',()=>openTask(row.taskId).catch(e=>notice(e.message)),'button quiet small'));
            if (['complete','failed'].includes(row.stage) && !['pending','imported'].includes(row.libraryStatus)) actions.append(button(row.stage==='complete'?'开始识别':'重试识别',()=>command('retry'),'button quiet small'));
            if (row.stage!=='recognizing') {
              const remove=button(['waiting','unconfirmed'].includes(row.stage)?'取消跟踪':'清除记录',()=>command('remove'),'button quiet small');
              remove.title=(['waiting','unconfirmed'].includes(row.stage)?'取消跟踪':'清除记录')+'：仅移除此处记录，保留 qBit 任务、文件和媒体库内容';
              actions.append(remove);
            }
            entry.append(info,actions);host.append(entry);
          }
        }
      } catch(error){if(host.isConnected)host.textContent=error.message;last=null;}
      clearTimeout(timer);
      if(host.isConnected && !host.hidden)timer=setTimeout(refresh,1200);
    }
    void refresh();
  }
  function settings(content, pref) {
    const form=node('form','settings-card organizer-form');
    form.append(node('h3','','qBittorrent 下载监控'),node('p','inline-note','请在 qBittorrent 的「选项 → Web UI」中启用 Web 用户界面。'));
    function field(label,type,value) {
      const row=node('label','organizer-field'),control=node('input');
      control.type=type;
      if(type==='checkbox')control.checked=value;else control.value=value;
      row.append(node('span','',label),control);form.append(row);
      return control;
    }
    const url=field('本机 Web UI 地址','url',pref.url),username=field('用户名','text',pref.username);
    const password=field('密码','password','');
    password.placeholder=pref.hasPassword?'已保存，留空沿用':'Web UI 密码';
    const automatic=field('下载完成后自动识别','checkbox',pref.automatic);
    const status=node('p','inline-note');
    status.setAttribute('role','status');
    async function configure(test) {
      check.disabled=save.disabled=true;
      try{
        await ipc.invoke('downloads:configure',{test,input:{url:url.value,username:username.value,password:password.value,automatic:automatic.checked}});
        status.textContent=test?'连接成功':'下载监控设置已保存';
        if(!test && password.value){password.value='';password.placeholder='已保存，留空沿用';}
      }catch(error){status.textContent=error.message;}
      finally{check.disabled=save.disabled=false;}
    }
    const check=button('测试连接',()=>configure(true),'button quiet'),save=button('保存设置',null,'button primary');
    check.type='button';save.type='submit';
    form.onsubmit=e=>{e.preventDefault();void configure(false);};
    const actions=node('div','organizer-actions');actions.append(check,save);form.append(actions,status);
    content.append(form);
  }
  function render() {
    setHeader('下载任务','查看下载进度、审核方案和入库状态');
    const content=container();
    if(content.querySelector('.download-list'))return;
    const host=node('section','download-list');
    content.replaceChildren(host);
    list(host);
  }
  return {render,settings};
}
module.exports={downloads};
