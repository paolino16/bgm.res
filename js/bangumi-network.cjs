const fs=require('fs/promises');const path=require('path');const {createHash}=require('crypto');const {pathToFileURL}=require('url');
class BangumiNetwork{
  constructor({net,directory,concurrency=4}){this.net=net;this.directory=directory;this.running=0;this.queue=[];this.limit=concurrency;this.pending=new Map();}
  async limited(fn){if(this.running>=this.limit)await new Promise(r=>this.queue.push(r));this.running++;try{return await fn();}finally{this.running--;this.queue.shift()?.();}}
  async raw({url,method='GET',headers={},body},binary=false){
    const parsed=new URL(url);if(parsed.protocol!=='https:'||!['api.bgm.tv','lain.bgm.tv','lain.bangumi.tv'].includes(parsed.hostname))throw Error('不支持的 Bangumi 地址');
    return this.limited(()=>new Promise((resolve,reject)=>{
      let done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
      const request=this.net.request({url,method,redirect:'follow'});
      request.setHeader('User-Agent','JimHan/bgm.res/0.19.0 (https://github.com/JimHans/bgm.res)');
      for(const [name,value]of Object.entries(headers))if(!/^(host|connection|content-length|user-agent)$/i.test(name)&&value!=null)request.setHeader(name,String(value));
      const timer=setTimeout(()=>{request.abort();finish(Error('Bangumi 请求超时'));},15000);
      request.on('error',e=>finish(e));
      request.on('response',response=>{const chunks=[];let size=0;response.on('data',c=>{size+=c.length;if(size>16*1024*1024){request.abort();finish(Error('Bangumi 响应过大'));}else chunks.push(c);});response.on('error',e=>finish(e));response.on('end',()=>finish(null,{status:response.statusCode,body:binary?Buffer.concat(chunks):Buffer.concat(chunks).toString('utf8')}));});
      if(body)request.write(body);request.end();
    }));
  }
  async image(url){
    if(!url||!/^https:\/\/(lain\.bgm\.tv|lain\.bangumi\.tv)\//.test(url))return url;
    const filename=path.join(this.directory,'covers',createHash('sha256').update(url).digest('hex')+'.jpg');
    try{await fs.access(filename);return pathToFileURL(filename).href;}catch{}
    const r=await this.raw({url},true);if(r.status!==200)throw Error('封面 HTTP '+r.status);
    await fs.mkdir(path.dirname(filename),{recursive:true});const temp=filename+'.tmp';await fs.writeFile(temp,r.body);await fs.rename(temp,filename);return pathToFileURL(filename).href;
  }
  async cachedSubject(id){
    if(!/^\d+$/.test(String(id)))return null;
    const url='https://api.bgm.tv/v0/subjects/'+id;
    const filename=path.join(this.directory,'metadata-cache',createHash('sha256').update(url).digest('hex')+'.json');
    try{return this.relocateSubject(JSON.parse(JSON.parse(await fs.readFile(filename,'utf8')).body));}catch{return null;}
  }
  relocateSubject(info){
    if(info.images)for(const key of Object.keys(info.images))info.images[key]=require('./cover-path.cjs').resolveCover(info.images[key],this.directory);
    return info;
  }
  async request(options){
    const u=new URL(options.url);if(u.hostname!=='api.bgm.tv'||u.protocol!=='https:')throw Error('只允许 Bangumi API');
    const isPublic=(options.method||'GET').toUpperCase()==='GET'&&!Object.keys(options.headers||{}).some(k=>k.toLowerCase()==='authorization');
    const hash=createHash('sha256').update(u.href).digest('hex'),filename=path.join(this.directory,'metadata-cache',hash+'.json');
    let cached;if(isPublic)try{cached=JSON.parse(await fs.readFile(filename,'utf8'));}catch{}
    if(cached&&/^\/v0\/subjects\/\d+$/.test(u.pathname))try{cached.body=JSON.stringify(this.relocateSubject(JSON.parse(cached.body)));}catch{}
    if(cached&&Date.now()-cached.saved<10*60*1000)return {status:200,body:cached.body,cached:true};
    // Detail views may show an existing snapshot while the caller refreshes it.
    if(cached&&options.preferCached&&isPublic)return {status:200,body:cached.body,cached:true,stale:true};
    let response;
    try{response=await this.raw(options);}catch(e){if(cached)return {status:200,body:cached.body,cached:true,stale:true};throw e;}
    if(response.status>=500&&cached)return {status:200,body:cached.body,cached:true,stale:true};
    if(isPublic&&response.status===200){
      if(/^\/v0\/subjects\/\d+$/.test(u.pathname)){
        const info=JSON.parse(response.body);if(info.images?.large)try{const local=await this.image(info.images.large);info.images={...info.images,large:local,common:local};response.body=JSON.stringify(info);}catch{/* Keep remote artwork if the image host alone is unavailable. */}
      }
      await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,JSON.stringify({saved:Date.now(),body:response.body}));
    }
    return response;
  }
}
module.exports={BangumiNetwork};
