'use strict';
const {sources}=require('./subtitle-browser-ui.cjs');
function create({ipc,node,button,notice}){
  const browser=require('./subtitle-browser-ui.cjs').create({ipc,node,button,notice});
  const el=(tag,cls,text)=>node(tag,cls,text);
  const note=text=>el('p','inline-note',text);
  const safe=fn=>async(...args)=>{try{await fn(...args);}catch(error){notice(error.message);}};
  function settings(host,{onReturn}={}){
    const card=el('section','settings-card subtitle-api-settings');card.id='subtitle-api-settings';
    card.append(el('h3','','字幕服务'),note('射手网使用个人 API Token。论坛搜索不需要此配置。'));
    const body=el('div');card.appendChild(body);host.appendChild(card);
    if(onReturn)card.appendChild(button('返回字幕搜索',safe(onReturn),'button quiet small'));
    async function load(){
      body.replaceChildren(note('正在读取字幕服务配置…'));
      try{draw(await ipc.invoke('subtitle-sources:settings'));}catch(error){body.replaceChildren(note(error.message),button('重试',safe(load)));}
    }
    function draw(value){
      if(!card.isConnected)return;body.replaceChildren();
      const status=note(value.configured?(value.persisted?'Token 已配置并加密保存在本机。':'Token 仅在本次运行有效；系统加密不可用，未保存到磁盘。'):'尚未配置。可在射手网注册后的用户面板获取 API Token。');
      const controls=el('form','subtitle-online-token'),token=el('input');token.type='password';token.autocomplete='off';token.maxLength=32;token.placeholder=value.configured?'输入新 Token 可替换现有配置':'32 位 API Token';token.setAttribute('aria-label','射手网 API Token');
      const save=button('保存 Token',()=>{});save.type='submit';
      controls.onsubmit=safe(async event=>{event.preventDefault();if(!token.value.trim())throw Error('请输入 Token；移除配置请使用“移除 Token”');save.disabled=true;try{const next=await ipc.invoke('subtitle-sources:configure',token.value);token.value='';draw(next);notice('射手网 Token 已更新');}finally{save.disabled=false;}});
      controls.append(token,save);
      if(value.configured)controls.appendChild(button('移除 Token',safe(async()=>draw(await ipc.invoke('subtitle-sources:configure','')))));
      body.append(status,controls,button('打开射手网',safe(()=>ipc.invoke('subtitle-sources:open','https://assrt.net/')),'button quiet small'));
    }
    load();return card;
  }
  return {mount:browser.mount,settings,focus:browser.focus};
}
module.exports={create,sources};
