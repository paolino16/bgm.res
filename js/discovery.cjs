'use strict';

const PAGE_SIZE = 24;
const SCAN_SIZE = 50;
const TAG_SORTS = [['match','匹配度'],['heat','收藏人数'],['rank','排名'],['score','评分']];
const COLLECTIONS = [[1,'想看'],[3,'在看'],[4,'搁置'],[5,'抛弃'],[2,'看过']];
const CATEGORIES = [['1','TV'],['5','WEB'],['2','OVA'],['3','剧场版'],['0','其他']];
const FACETS = {
  来源:'原创 漫画改 游戏改 小说改 动画改 影视改'.split(' '),
  类型:'科幻 喜剧 同人 百合 校园 惊悚 后宫 机战 悬疑 恋爱 奇幻 推理 运动 耽美 音乐 战斗 冒险 萌系 穿越 玄幻 乙女 恐怖 历史 日常 剧情 武侠 短片集 美食 职场'.split(' '),
  地区:'日本 欧美 中国 美国 韩国 法国 英国 中国香港 俄罗斯 苏联 捷克 中国台湾 马来西亚'.split(' '),
  受众:'BL GL 子供向 女性向 少女向 少年向 青年向 无cp'.split(' ')
};
function subject(row) {
  return {id:row.id, name:row.name || '', cn:row.name_cn || '', date:row.date || '',
    tags:row.meta_tags || [], platform:row.platform || '', cover:row.images?.small || row.images?.common || '',
    score:row.rating?.score ?? row.score, rank:row.rating?.rank ?? row.rank, episodes:row.eps || 0};
}

function service({network,store,safeStorage,snapshotStore=store}) {
  const key='bangumiAccount';
  let revision=0,verifiedAt=0;
  const account=()=>store.get(key);
  const memory=new Map(),pending=new Map(),rankHeads=new Map();
  let generation=0,verifying;
  function invalidate(){
    generation++;memory.clear();pending.clear();rankHeads.clear();
    snapshotStore.delete('discoverySnapshots.rank');snapshotStore.delete('discoverySnapshots.rankScan');snapshotStore.delete('discoverySnapshots.collections');
  }
  function snapshot(kind){
    const user=account()?.username||'';
    const saved=memory.get(kind)||snapshotStore.get('discoverySnapshots.'+kind);
    if(!saved||saved.user!==user||Date.now()-saved.time>600000)return null;
    if(saved.value)return saved.value;
    try{
      const value=JSON.parse(safeStorage.decryptString(Buffer.from(saved.sealed,'base64')));
      memory.set(kind,{user,time:saved.time,value});return value;
    }catch{return null;}
  }
  function cached(kind,load){
    const value=snapshot(kind);if(value)return Promise.resolve(value);
    if(pending.has(kind))return pending.get(kind);
    const epoch=generation,current=revision,user=account()?.username||'';
    const task=load().then(value=>{
      if(current===revision && epoch===generation && !value.changed && !value.expired){
        const time=Date.now();
        memory.set(kind,{time,user,value});
        try{
          snapshotStore.set('discoverySnapshots.'+kind,user?{user,time,sealed:safeStorage.encryptString(JSON.stringify(value)).toString('base64')}:{user,time,value});
        }catch{/* Memory caching remains available when disk storage is unavailable. */}
      }
      return value;
    }).finally(()=>{if(pending.get(kind)===task)pending.delete(kind);});
    pending.set(kind,task);return task;
  }
  function status() {
    const saved=account();
    return {username:saved?.username || '',expired:Boolean(saved?.expired),revision,
      supportsRankFilters:true,supportsTagSearch:true,apiTagSorting:true};
  }
  async function request(route,token,body) {
    const headers=token ? {Authorization:'Bearer '+token} : {};
    if(body)headers['Content-Type']='application/json';
    const result=await network.raw({url:'https://api.bgm.tv'+route,headers,
      method:body?'POST':'GET',body:body && JSON.stringify(body)});
    if(result.status!==200)throw Object.assign(Error('Bangumi 请求失败（HTTP '+result.status+'）'),{status:result.status});
    return JSON.parse(result.body);
  }
  async function rankedSearch(body,token,offset,size){
    const key=JSON.stringify([revision,body,size]);
    async function read(rankFilter,start){
      const data=await request('/v0/search/subjects?limit='+size+'&offset='+start,token,
        {...body,filter:{...body.filter,rank:[rankFilter]}});
      if(!Array.isArray(data.data)||!Number.isSafeInteger(data.total)||data.total<0)throw Error('Bangumi 返回的列表不完整');
      return data;
    }
    // Bangumi assigns rank 0 to unranked subjects. Keep two disjoint result sets
    // so a jump to any page uses the same global ordering as sequential paging.
    if(!rankHeads.has(key)){
      if(rankHeads.size>=12)rankHeads.delete(rankHeads.keys().next().value);
      const heads=Promise.all([read('>0',0),read('<1',0)]).catch(error=>{
        if(rankHeads.get(key)===heads)rankHeads.delete(key);
        throw error;
      });
      rankHeads.set(key,heads);
    }
    const [ranked,unranked]=await rankHeads.get(key);
    const total=ranked.total+unranked.total;
    if(offset>=total)return {data:[],total};
    const positive=offset<ranked.total,head=positive?ranked:unranked;
    const start=positive?offset:offset-ranked.total;
    const batch=start<head.data.length?head.data.slice(start):(await read(positive?'>0':'<1',start)).data;
    return {data:batch,total};
  }
  function expire(saved){
    revision++;invalidate();store.set(key,{...saved,expired:true});
    return status();
  }
  async function verify(){
    const saved=account(),current=revision;
    if(!saved || saved.expired || Date.now()-verifiedAt<60000)return status();
    const token=safeStorage.decryptString(Buffer.from(saved.secret,'base64'));
    try{
      const me=await request('/v0/me',token);
      if(current===revision){
        if(me.username!==saved.username)return expire(saved);
        verifiedAt=Date.now();
      }
    }catch(e){
      if(current===revision && e.status===401)return expire(saved);
      throw e;
    }
    return status();
  }
  async function login(input) {
    const token=String(input || '').trim();
    if(!token || /\s/.test(token) || token.length>4096)throw Error('请输入有效的 bgm_token');
    const current=++revision;
    let me;
    try { me=await request('/v0/me',token); }
    catch(e){if(e.status===401)throw Error('bgm_token 无效或已过期');throw e;}
    if(!me.username || current!==revision)throw Error('登录状态已变化，请重试');
    verifiedAt=Date.now();invalidate();
    store.set(key,{username:me.username,secret:safeStorage.encryptString(token).toString('base64')});
    return status();
  }
  function logout(){revision++;invalidate();store.delete(key);return status();}
  async function page(q){
    if(q.revision!==revision)return {changed:true};
    if(account()?.expired)return {expired:true};
    if(!Number.isSafeInteger(q.offset)||q.offset<0)throw Error('无效的页码');
    if(q.mode==='collection'&&account()){
      const snap=snapshot('collections');
      const rows=snap?.byType[q.type];
      const size=q.scan?SCAN_SIZE:PAGE_SIZE;
      if(rows)return {rows:rows.slice(q.offset,q.offset+size),count:Math.min(size,Math.max(0,rows.length-q.offset)),total:rows.length};
    }
    if(q.mode!=='collection'&&!q.offset&&!q.query&&!q.cat&&!q.year&&!q.month&&(!q.sort||q.sort==='rank')&&!Object.values(q.facets||{}).some(Boolean))
      return cached(q.scan?'rankScan':'rank',()=>readPage(q));
    return readPage(q);
  }
  async function readPage(q) {
    const saved=account(), current=revision;
    if(q.revision!==current)return {changed:true};
    if(saved?.expired)return {expired:true};
    const token=saved && safeStorage.decryptString(Buffer.from(saved.secret,'base64'));
    const offset=Number(q.offset);
    const size=q.scan?SCAN_SIZE:PAGE_SIZE;
    const params=new URLSearchParams({limit:String(size),offset:String(offset)});
    const tags=Object.entries(FACETS).map(([key,values])=>values.includes(q.facets?.[key])?q.facets[key]:null).filter(Boolean);
    // Date order comes from browse. Read a larger batch when filtering its public tags locally.
    if(q.mode!=='collection' && q.sort==='date' && !q.query && tags.length)params.set('limit',String(SCAN_SIZE));
    let route,body;
    if(q.mode==='collection'){
      if(!saved || !COLLECTIONS.some(([id])=>id===q.type))throw Error('请先登录并选择收藏分类');
      params.set('subject_type','2');params.set('type',String(q.type));
      route='/v0/users/'+encodeURIComponent(saved.username)+'/collections';
    }else if(q.query || (tags.length && q.sort!=='date')){
      route='/v0/search/subjects';
      body={keyword:String(q.query||'').slice(0,200),sort:'rank',filter:{type:[2]}};
      if(q.searchBy==='tag' && q.query){
        const terms=[...new Set(body.keyword.split(/[,，、]/u).map(term=>term.trim()).filter(Boolean))];
        if(!terms.length)throw Error('请输入至少一个标签');
        body.keyword='';
        body.sort=TAG_SORTS.some(([value])=>value===q.tagSort)?q.tagSort:'match';
        body.filter.tag=terms;
      }
      if(tags.length){
        body.filter.meta_tags=tags;
        if(!q.query)body.filter.rank=['>0'];
      }
      if(/^\d{4}$/.test(q.year)){
        const month=Number(q.month)||1;
        const start=q.year+'-'+String(month).padStart(2,'0')+'-01';
        const end=new Date(Date.UTC(Number(q.year)+(q.month?0:1),q.month?month:0,1)).toISOString().slice(0,10);
        body.filter.air_date=['>='+start,'<'+end];
      }
    }else{
      route='/v0/subjects';params.set('type','2');params.set('sort',q.sort==='date'?'date':'rank');
      if(CATEGORIES.some(([id])=>id===q.cat))params.set('cat',q.cat);
      if(/^\d{4}$/.test(q.year))params.set('year',q.year);
      if(/^(?:[1-9]|1[0-2])$/.test(q.month))params.set('month',q.month);
    }
    try {
      const data=body?.sort==='rank'&&!body.filter.rank
        ?await rankedSearch(body,token,offset,size)
        :await request(route+'?'+params,token,body);
      if(current!==revision)return {changed:true};
      if(!Array.isArray(data.data) || !Number.isSafeInteger(data.total))throw Error('Bangumi 返回的列表不完整');
      const rows=q.mode==='collection'?data.data.map(item=>item.subject):data.data;
      return {rows:rows.filter(row=>row?.id).map(subject),count:data.data.length,total:data.total};
    }catch(error){
      if(current!==revision)return {changed:true};
      if(saved && error.status===401){expire(saved);return {expired:true};}
      throw error;
    }
  }
  async function collectionIds({revision:expected}){
    if(expected!==revision)return {changed:true};
    if(account()?.expired)return {expired:true};
    if(!account())throw Error('请先登录 Bangumi');
    const saved=await cached('collections',()=>loadCollections(expected));
    return saved.ids?{ids:saved.ids}:saved;
  }
  async function loadCollections(expected){
    const saved=account();
    if(revision!==expected)return {changed:true};
    if(saved?.expired)return {expired:true};
    if(!saved)throw Error('请先登录 Bangumi');
    const token=safeStorage.decryptString(Buffer.from(saved.secret,'base64'));
    const base='/v0/users/'+encodeURIComponent(saved.username)+'/collections?subject_type=2&limit=100&offset=';
    try{
      const first=await request(base+0,token), ids=new Set(),byType=Object.fromEntries(COLLECTIONS.map(([type])=>[type,[]]));
      const size=first.limit,total=first.total;
      if(!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(size)||size<1)throw Error('收藏分页无效，请刷新重试');
      function add(page,offset){
        if(page.total!==total||!Array.isArray(page.data)||page.data.length!==Math.min(size,total-offset))
          throw Error('收藏列表发生变化，请刷新重试');
        for(const item of page.data){
          const id=item.subject_id;
          if(!Number.isSafeInteger(id)||id<=0||ids.has(id))throw Error('收藏条目数据不完整，请刷新重试');
          ids.add(id);
          if(item.subject && byType[item.type])byType[item.type].push(subject(item.subject));
        }
      }
      add(first,0);
      for(let offset=size;offset<total;offset+=3*size){
        if(expected!==revision)return {changed:true};
        const offsets=[offset,offset+size,offset+2*size].filter(value=>value<total);
        const pages=await Promise.all(offsets.map(value=>request(base+value,token)));
        pages.forEach((page,i)=>add(page,offsets[i]));
      }
      return expected===revision?{ids:[...ids],byType}:{changed:true};
    }catch(e){
      if(expected!==revision)return {changed:true};
      if(e.status===401){expire(saved);return {expired:true};}
      throw e;
    }
  }
  async function titles({id,revision:expected}){
    if(!Number.isSafeInteger(id)||id<=0||expected!==revision)return null;
    const saved=account();
    if(saved?.expired)return null;
    const token=saved && safeStorage.decryptString(Buffer.from(saved.secret,'base64'));
    try{
      const info=await request('/v0/subjects/'+id,token);
      return expected===revision?{name:info.name,name_cn:info.name_cn,infobox:info.infobox,images:info.images}:null;
    }catch(e){
      if(saved && e.status===401 && expected===revision)expire(saved);
      throw e;
    }
  }
  function verifiedStatus(){
    if(verifying?.revision===revision)return verifying.task;
    const ticket={revision,task:verify().finally(()=>{if(verifying===ticket)verifying=null;})};
    verifying=ticket;return ticket.task;
  }
  return {login,logout,status:verifiedStatus,page,titles,collectionIds,invalidate};
}
function register({ipcMain,network,sysdata,safeStorage,snapshotStore}){
  const api=service({network,store:sysdata,safeStorage,snapshotStore});
  for(const method of ['status','login','logout','page','titles','collectionIds','invalidate'])ipcMain.handle('discovery:'+method,(_,arg)=>api[method](arg));
}
module.exports={register,service,PAGE_SIZE,COLLECTIONS,CATEGORIES,FACETS,TAG_SORTS};
