const path=require('path');
const {allSlots,projectEpisodes}=require('./rename-binding-core.cjs');
function install({$,store,ipc=require('electron').ipcRenderer}){
  $.ajaxPrefilter(function(options){if(/^https:\/\/api\.bgm\.tv\//.test(options.url))options.timeout=0;});
  $.ajaxTransport('+*',function(options){
    let url;try{url=new URL(options.url);}catch{return;}
    if(url.protocol!=='https:'||url.hostname!=='api.bgm.tv')return;
    const list=url.pathname==='/v0/episodes',collection=url.pathname.match(/^\/v0\/users\/[^/]+\/collections\/(\d+)\/episodes$/);
    const subjectId=list?url.searchParams.get('subject_id'):collection?.[1];
    const work=subjectId?Object.values(store.get()).find(w=>w?.RenameBinding&&String(w.bgmID)===String(subjectId)):null;
    const method=(options.type||'GET').toUpperCase();let aborted=false;
    const request=async(u,headers,body)=>{
      const response=await ipc.invoke('bangumi:request',{url:String(u),method,headers,body});
      if(response.error)throw Error(response.error);
      if(response.status<200||response.status>=300){const error=Error('Bangumi HTTP '+response.status);error.status=response.status;throw error;}
      return response.body?JSON.parse(response.body):{};
    };
    return {send(headers,complete){(async()=>{
      let body=options.data;
      if(work&&collection&&method==='PATCH'){
        const payload=JSON.parse(body),allowed=new Set([...allSlots(work),...allSlots(work,'SP')].map(s=>String(s.EpisodeID)).filter(s=>/^\d+$/.test(s)));
        const ids=(payload.episode_id||[]).map(String).filter(id=>allowed.has(id));if(!ids.length)throw Error('没有明确绑定的章节，未发送同步');
        payload.episode_id=[...new Set(ids)].map(Number);body=JSON.stringify(payload);
      }
      let data;
      if(work&&method==='GET'&&(list||collection)){
        const rows=[];let offset=0;
        while(true){const pageURL=new URL(url);pageURL.searchParams.set('limit','100');pageURL.searchParams.set('offset',String(offset));const page=await request(pageURL,headers);if(aborted)return;
          if(!Array.isArray(page.data))throw Error('章节响应格式错误');rows.push(...page.data);offset+=page.data.length;if(offset>=Number(page.total))break;if(!page.data.length||offset>10000)throw Error('章节分页不完整');}
        const projected=projectEpisodes(work,rows,!!collection);data={data:projected,total:projected.length,limit:projected.length,offset:0};
      }else data=await request(url,headers,body);
      if(!aborted)complete(200,'OK',{text:JSON.stringify(data)},'Content-Type: application/json');
    })().catch(error=>{if(!aborted)complete(error.status||502,error.message,{text:JSON.stringify({error:error.message})},'Content-Type: application/json');});},abort(){aborted=true;}};
  });
}
function resolveMediaPath(base,relative){if(!relative||relative===false)return '';return path.resolve(base||'',relative);}
function wrapPlayer(original,{store,dialog}){return function(mediaId,index,type){
  const prefix=`WorkSaveNo${mediaId}.${type}Details.${type}${index}`;const slot=store.get(prefix);
  if(slot?.Versions?.length>1){const chosen=dialog.showMessageBoxSync({type:'question',title:'选择本地版本',message:'同一章节有多个重命名产物',detail:'选择本次播放的版本；章节和观看状态不变。',buttons:[...slot.Versions.map(v=>path.basename(v.path)),'取消'],cancelId:slot.Versions.length,noLink:true});if(chosen>=slot.Versions.length||chosen<0)return;const selected=slot.Versions[chosen].path;store.set(prefix+'.URL',path.relative(store.get(`WorkSaveNo${mediaId}.URL`),selected));store.set(prefix+'.AbsolutePath',selected);}
  return original.apply(this,arguments);
};}
module.exports={install,resolveMediaPath,wrapPlayer};
