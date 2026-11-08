'use strict';

// Public PocketBase API documented at https://seadex.moe/about#api.
const ENDPOINT='https://seadex.moe/api/collections/torrents/records';
function normalizeHash(value){
  return typeof value==='string'&&/^[a-f0-9]{40}$/i.test(value.trim())?value.trim().toLowerCase():'';
}
function rowHash(row){
  const hash=normalizeHash(row.hash);
  if(hash)return hash;
  try{
    const magnet=new URL(row.magnet);
    if(magnet.protocol!=='magnet:')return '';
    for(const xt of magnet.searchParams.getAll('xt')){
      if(/^urn:btih:/i.test(xt)){
        const found=normalizeHash(xt.slice(9));
        if(found)return found;
      }
    }
  }catch{}
  return '';
}
function requestJSON(net,url){
  return new Promise((resolve,reject)=>{
    const request=net.request({url,method:'GET',redirect:'error',useSessionCookies:false});
    let done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{finish(Error('SeaDex 请求超时'));request.abort();},12000);
    request.setHeader('Accept','application/json');
    request.setHeader('User-Agent','bgm.res/0.19.0 SeaDex integration');
    request.on('error',error=>finish(error));
    request.on('response',response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>2*1024*1024){finish(Error('SeaDex 响应过大'));request.abort();}
        else chunks.push(chunk);
      });
      response.on('error',error=>finish(error));
      response.on('end',()=>{
        try{
          if(response.statusCode!==200)throw Error('SeaDex HTTP '+response.statusCode);
          finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));
        }catch(error){finish(error);}
      });
    });
    request.end();
  });
}

class SeaDexClient{
  constructor({fetchJSON,now=Date.now,ttl=3600000}){
    this.fetchJSON=fetchJSON;this.now=now;this.ttl=ttl;
    this.cache=new Map();this.pending=new Map();this.queue=Promise.resolve();
  }
  async lookup(values){
    if(!Array.isArray(values)||values.length>200)throw Error('无效的 SeaDex 哈希列表');
    const hashes=[...new Set(values.map(normalizeHash).filter(Boolean))];
    const missing=hashes.filter(hash=>!this.pending.has(hash)&&
      (!this.cache.has(hash)||this.now()-this.cache.get(hash).time>=this.ttl));
    for(let i=0;i<missing.length;i+=25){
      const batch=missing.slice(i,i+25);
      const task=this.queue.then(()=>this.fetchBatch(batch));
      this.queue=task.catch(()=>{});
      for(const hash of batch)this.pending.set(hash,task);
      // Cleanup both success and failure without creating an unhandled rejection.
      void task.then(()=>this.clearPending(batch,task),()=>this.clearPending(batch,task));
    }
    await Promise.all(hashes.map(hash=>this.pending.get(hash)));
    return {matches:Object.fromEntries(hashes.map(hash=>[hash,this.cache.get(hash)?.value??null]))};
  }
  clearPending(batch,task){for(const hash of batch)if(this.pending.get(hash)===task)this.pending.delete(hash);}
  async fetchBatch(hashes){
    const found=new Map(hashes.map(hash=>[hash,null]));
    let page=1,pages=1;
    do{
      const url=new URL(ENDPOINT);
      url.searchParams.set('filter',hashes.map(hash=>'infoHash="'+hash+'"').join(' || '));
      url.searchParams.set('page',String(page));url.searchParams.set('perPage','200');
      url.searchParams.set('expand','entries_via_trs');
      url.searchParams.set('fields','id,infoHash,isBest,tags,updated,expand.entries_via_trs.alID,expand.entries_via_trs.notes');
      const data=await this.fetchJSON(url.href);
      if(!Array.isArray(data.items)||!Number.isInteger(data.totalPages)||data.totalPages<0||data.totalPages>50)
        throw Error('SeaDex 返回格式无效');
      pages=data.totalPages;
      for(const item of data.items){
        const hash=normalizeHash(item.infoHash);
        if(!found.has(hash))continue;
        if(typeof item.isBest!=='boolean')throw Error('SeaDex 返回格式无效');
        const entries=(item.expand?.entries_via_trs||[]).filter(entry=>Number.isSafeInteger(entry.alID)&&entry.alID>0)
          .map(entry=>({url:'https://seadex.moe/'+entry.alID,notes:String(entry.notes||'').slice(0,4000)}));
        // A torrent may be linked to several entries or mirrored records.
        const existing=found.get(hash);
        const level=item.isBest?'best':'alt';
        const tags=Array.isArray(item.tags)?item.tags.filter(tag=>typeof tag==='string'):[];
        found.set(hash,{level:existing?.level==='best'?'best':level,
          tags:[...new Set([...(existing?.tags||[]),...tags])],
          entries:[...(existing?.entries||[]),...entries].filter((entry,i,all)=>all.findIndex(other=>other.url===entry.url)===i)});
      }
      page++;
    }while(page<=pages);
    // Do not cache partial responses or failures as "not listed".
    for(const [hash,value]of found)this.cache.set(hash,{value,time:this.now()});
    while(this.cache.size>10000)this.cache.delete(this.cache.keys().next().value);
  }
}
module.exports={SeaDexClient,requestJSON,normalizeHash,rowHash};
