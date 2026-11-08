'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {service,COLLECTIONS}=require('../js/discovery.cjs');
const {localIndex,ownedLabel}=require('../js/discovery-ui.cjs');
const {pageSource,resultPages}=require('../js/discovery-pages.cjs');
test('搜索接口每批只返回20条时仍能按24条翻页',async()=>{
  const load=resultPages(async offset=>{
    const count=Math.min(20,48-offset);
    return {count,total:48,rows:Array.from({length:count},(_,i)=>offset+i)};
  });
  const first=await load(1,()=>true),second=await load(2,()=>true);
  assert.deepEqual([...first.rows,...second.rows],Array.from({length:48},(_,i)=>i));
});
test('登录后补取封面使用当前账号，只返回当前会话的图片地址',async()=>{
  const {api,set,requests}=setup();
  set(()=>({status:200,body:'{"username":"qa"}'}));
  const auth=await api.login('sample');
  const images={small:'https://lain.bgm.tv/r/200/pic/cover/l/test.jpg'};
  set(()=>({status:200,body:JSON.stringify({id:184740,images})}));
  assert.deepEqual((await api.titles({id:184740,revision:auth.revision})).images,images);
  assert.equal(requests.at(-1).headers.Authorization,'Bearer sample');
  api.logout();
  assert.equal(await api.titles({id:184740,revision:auth.revision}),null);
});
test('标签搜索使用 API 的 match 默认顺序，并支持多标签与公共标签组合',async()=>{
  const {api,requests}=setup();
  for(const sort of [undefined,'heat','score','title']){
    await api.page({revision:0,offset:24,searchBy:'tag',query:'治愈，日常,治愈',tagSort:sort,facets:{地区:'日本'}});
    const req=requests.at(-1);
    assert.equal(new URL(req.url).pathname,'/v0/search/subjects');
    assert.equal(new URL(req.url).searchParams.get('offset'),'24');
    assert.deepEqual(JSON.parse(req.body),{keyword:'',sort:sort==='title'?'match':sort||'match',filter:{type:[2],tag:['治愈','日常'],meta_tags:['日本']}});
  }
  await assert.rejects(api.page({revision:0,offset:0,query:'，、',searchBy:'tag'}),/至少一个标签/);
});
test('排名排序先列全部正排名，翻页与跳页跨过分界后才列无排名作品',async()=>{
  const {api,set}=setup();
  const ranked=Array.from({length:26},(_,i)=>({id:i+1,rating:{rank:i+3}}));
  const unranked=Array.from({length:25},(_,i)=>({id:i+101,rating:{rank:0}}));
  set(req=>{
    const body=JSON.parse(req.body);
    assert.deepEqual(body.filter.tag,['百合']);
    assert.equal(body.sort,'rank');
    const rows=body.filter.rank[0]==='>0'?ranked:unranked;
    const offset=Number(new URL(req.url).searchParams.get('offset'));
    return {status:200,body:JSON.stringify({total:rows.length,data:rows.slice(offset,offset+20)})};
  });
  const load=resultPages(offset=>api.page({revision:0,query:'百合',searchBy:'tag',tagSort:'rank',offset}));
  const last=await load(3,()=>true),first=await load(1,()=>true),middle=await load(2,()=>true);
  assert.deepEqual([...first.rows,...middle.rows,...last.rows].map(row=>row.id),[...ranked,...unranked].map(row=>row.id));
});
test('预取与点击共用请求，过滤后翻页不重扫前页',async()=>{
  const calls=[];let checks=0;
  const read=pageSource(async offset=>{
    calls.push(offset);
    return {count:24,total:120,rows:Array.from({length:24},(_,i)=>offset+i)};
  });
  const load=resultPages(read,n=>{checks++;return n%2===0;});
  assert.equal((await load(1,()=>true)).rows.length,24);
  const [prefetch,next]=await Promise.all([load(2,()=>true),load(2,()=>true)]);
  assert.deepEqual(prefetch,next);assert.deepEqual(calls,[0,24,48,72]);
  assert.equal(checks,96);assert.equal(next.rows[0],48);
  const last=await load(3,()=>true);assert.equal(last.rows.length,12);assert.equal(last.more,false);
  await load(1,()=>true);assert.equal(checks,120);
});

test('筛选使用50条批次，首页快照与普通浏览隔离',async()=>{
  const {api,set,requests}=setup();
  set(req=>{
    const url=new URL(req.url),size=Number(url.searchParams.get('limit'));
    return {status:200,body:JSON.stringify({total:200,data:Array.from({length:size},(_,i)=>({id:i+1}))})};
  });
  assert.equal((await api.page({revision:0,offset:0})).count,24);
  assert.equal((await api.page({revision:0,offset:0,scan:true})).count,50);
  await api.page({revision:0,offset:0,scan:true});assert.equal(requests.length,2);
  api.invalidate();await api.page({revision:0,offset:0,scan:true});assert.equal(requests.length,3);
  await api.page({revision:0,offset:50,scan:true,sort:'date',facets:{地区:'日本'}});
  assert.equal(new URL(requests.at(-1).url).searchParams.get('limit'),'50');
});

test('有限并发扫描按原顺序合并，不重复请求或重扫已筛选批次',async()=>{
  const waiting=new Map(),calls=[];let running=0,peak=0,checks=0;
  const read=pageSource(offset=>{
    calls.push(offset);peak=Math.max(peak,++running);
    return new Promise(resolve=>waiting.set(offset,()=>{
      running--;resolve({total:300,count:50,rows:Array.from({length:50},(_,i)=>offset+i)});
    }));
  });
  const tick=()=>new Promise(r=>setImmediate(r));
  const load=resultPages(read,id=>{checks++;return id>=150;},{scanAhead:3});
  const first=load(1,()=>true);await tick();waiting.get(0)();await tick();
  assert.deepEqual(calls,[0,50,100,150]);assert.equal(peak,3);
  waiting.get(150)();waiting.get(100)();waiting.get(50)();await tick();
  // New lookahead requests are allowed, but cannot reorder the accepted results.
  const result=await first;assert.deepEqual(result.rows,Array.from({length:24},(_,i)=>150+i));
  const checked=checks;
  assert.deepEqual((await load(2,()=>true)).rows,Array.from({length:24},(_,i)=>174+i));
  assert.equal(checks,checked);assert.equal(new Set(calls).size,calls.length);assert.ok(peak<=3);
  for(const [offset,finish] of waiting)if(offset>=200)finish();
});

test('扫描兼容实际20条上限及排名分界处短批次，取消后不继续预读',async()=>{
  const calls=[],read=pageSource(async offset=>{
    calls.push(offset);
    const count=Math.min(20,offset<26?26-offset:86-offset);
    return {total:86,count,rows:Array.from({length:count},(_,i)=>offset+i)};
  });
  const load=resultPages(read,id=>id>=24,{scanAhead:3});
  const first=await load(1,()=>true),second=await load(2,()=>true);
  assert.deepEqual([...first.rows,...second.rows],Array.from({length:48},(_,i)=>24+i));
  assert.equal(new Set(calls).size,calls.length);
  let valid=true,reads=0;
  const cancelled=resultPages(async()=>{reads++;valid=false;return {total:100,count:20,rows:[]};},()=>false,{scanAhead:3});
  assert.equal(await cancelled(1,()=>valid),null);assert.equal(reads,1);
});
test('发现预读与首次进入共享请求，应用重新打开可复用首页快照',async()=>{
  const {api,requests,store,set}=setup();
  let resolve;set(()=>new Promise(r=>{resolve=r;}));
  const q={revision:0,offset:0,sort:'rank'};
  const warm=api.page(q),visible=api.page(q);
  assert.equal(requests.length,1);
  resolve({status:200,body:'{"total":1,"data":[{"id":326,"name":"SAC"}]}'});
  assert.deepEqual(await warm,await visible);
  const reopened=service({store,network:{raw:()=>assert.fail('unexpected network request')}});
  assert.equal((await reopened.page(q)).rows[0].id,326);
});
test('组合筛选传递公共标签和年份月份范围',async()=>{
  const {api,requests}=setup();
  await api.page({revision:0,offset:24,year:'2004',month:'12',facets:{来源:'漫画改',类型:'科幻',地区:'日本',受众:'青年向'}});
  const body=JSON.parse(requests[0].body);
  assert.deepEqual(body.filter.meta_tags,['漫画改','科幻','日本','青年向']);
  assert.deepEqual(body.filter.air_date,['>=2004-12-01','<2005-01-01']);
});
test('未收藏索引分页读取当前账号全部状态，拒绝不完整结果',async()=>{
  const {api,requests,set}=setup();
  set(()=>({status:200,body:'{"username":"qa"}'}));
  const session=await api.login('sample');
  set(q=>{
    const url=new URL(q.url);
    assert.equal(url.searchParams.get('type'),null);
    assert.equal(url.searchParams.get('subject_type'),'2');
    const start=Number(url.searchParams.get('offset'));
    return {status:200,body:JSON.stringify({total:5,limit:2,data:Array.from({length:Math.min(5-start,2)},(_,i)=>({subject_id:start+i+1}))})};
  });
  assert.deepEqual(await api.collectionIds(session),{ids:[1,2,3,4,5]});
  assert.equal(requests.length,4);
  assert.deepEqual(await api.collectionIds(session),{ids:[1,2,3,4,5]});
  assert.equal(requests.length,4);api.invalidate();
  set(()=>({status:200,body:'{"total":3,"limit":2,"data":[]}'}));
  await assert.rejects(api.collectionIds(session),/刷新/);
});
function setup(){
  const store=new Map(),requests=[];
  let handle=()=>({status:200,body:JSON.stringify({total:1,data:[{id:326,name:'SAC',rating:{rank:1,score:9.2}}]})});
  const network={raw:q=>{requests.push(q);return handle(q);}};
  const safeStorage={encryptString:t=>Buffer.from('sealed-'+t),decryptString:b=>b.toString().slice(7)};
  const api=service({network,store,safeStorage});
  return {api,requests,store,set:fn=>{handle=fn;}};
}
test('游客榜单使用官方分页和筛选，收藏要求登录',async()=>{
  const {api,requests}=setup(),q={revision:0,offset:24,year:'2004',month:'1',cat:'1',sort:'date'};
  const page=await api.page(q);
  assert.equal(page.rows[0].rank,1);
  const url=new URL(requests[0].url);
  assert.deepEqual(Object.fromEntries(url.searchParams),{limit:'24',offset:'24',type:'2',sort:'date',cat:'1',year:'2004',month:'1'});
  assert.equal(requests[0].headers.Authorization,undefined);
  await assert.rejects(api.page({...q,mode:'collection',type:1}),/登录/);
});
test('token 只用于官方 API，收藏归属来自 me，退出丢弃在途结果',async()=>{
  const {api,requests,set,store}=setup();
  set(()=>({status:200,body:'{"username":"current"}'}));
  const session=await api.login('sample');
  assert.equal(session.username,'current');
  assert.ok(!JSON.stringify([...store]).includes('sample'));
  set(()=>({status:200,body:'{"total":1,"data":[{"subject":{"id":9,"rank":4,"score":8}}]}'}));
  for(const [type] of COLLECTIONS){
    const page=await api.page({...session,mode:'collection',offset:0,type});
    assert.equal(page.rows[0].rank,4);
    assert.ok(requests.at(-1).url.includes('/users/current/collections?'));
    assert.equal(new URL(requests.at(-1).url).searchParams.get('type'),String(type));
  }
  await api.page({...session,offset:0,query:'攻壳'});
  assert.deepEqual(JSON.parse(requests.at(-1).body),{keyword:'攻壳',sort:'rank',filter:{type:[2],rank:['<1']}});
  assert.ok(requests.every(q=>q.headers.Authorization==='Bearer sample'));
  let resolve;set(()=>new Promise(r=>{resolve=r;}));
  const pending=api.page({...session,offset:0});api.logout();
  resolve({status:200,body:'{"total":0,"data":[]}'});
  assert.deepEqual(await pending,{changed:true});assert.equal(store.size,0);
});
test('过期凭据要求重新登录，没有回退游客数据',async()=>{
  const {api,set,requests}=setup();
  set(()=>({status:200,body:'{"username":"current"}'}));
  const session=await api.login('sample');
  set(()=>({status:401,body:''}));
  assert.deepEqual(await api.page({...session,offset:0}),{expired:true});
  const blocked=await api.status();
  assert.equal(blocked.expired,true);
  assert.deepEqual(await api.page({...blocked,offset:0}),{expired:true});
  assert.equal(requests.length,2);
});
test('正片映射按章节去重，合集按映射集数显示',()=>{
  const index=localIndex([{bgmID:2,EPDetails:{a:{Collection:true,EpisodeIDs:[8,9],URL:'a'},b:{EpisodeID:8,URL:'b'}}}]);
  assert.equal(index.get('2').episodes.size,2);
});

test('发现页只核对正片，合集中的特别章节和多个版本不重复计数',()=>{
  const work={id:'w1',bgmID:2,URL:'D:/Anime',EPDetails:{
    collection:{Collection:true,EpisodeIDs:[8,9,10],URL:'all.mkv'},
    duplicate:{EpisodeID:8,URL:'other.mkv'},
    missing:{EpisodeID:11,Versions:[{path:'D:/Anime/missing.mkv',availability:'missing'}]}
  },SPDetails:{op:{EpisodeID:12,URL:'op.mkv',EpisodeType:2}},RenameBinding:{resources:[
    {path:'D:/Anime/special.mkv',episodeId:10,type:1},
    {path:'D:/Anime/extra.mkv',type:'extra'},
    {path:'D:/Anime/foreign.mkv',subjectId:3,episodeId:13,type:1}
  ]}};
  const entry=localIndex([work,{...work,id:'w2'}]).get('2');
  const catalogue=[{id:8,type:0,sort:1},{id:9,type:0,sort:2},{id:11,type:0,sort:3},
    {id:10,type:1,sort:1},{id:12,type:2,sort:1},{id:13,type:3,sort:1}];
  assert.equal(ownedLabel(entry,{episodes:6},catalogue),'已收录 2/3 话');
  assert.equal(ownedLabel(undefined,{episodes:6}),'未入库');
});

test('特别章节不计入正片分子或分母，无目录时仅统计本地正片',()=>{
  const entry=localIndex([{id:'w',bgmID:2,URL:'D:/Anime',EPDetails:{ep:{EpisodeID:1,URL:'ep.mkv'}}}]).get('2');
  assert.equal(ownedLabel(entry,{episodes:3},[{id:1,type:0},{id:2,type:1},{id:3,type:1}]),
    '已收录 1/1 话');
  assert.equal(ownedLabel(entry,{episodes:1}),'已收录 1/1 话');
  const special=localIndex([{id:'w',bgmID:2,SPDetails:{sp:{EpisodeID:2,URL:'sp.mkv'}}}]).get('2');
  assert.equal(ownedLabel(special,{episodes:1}),'已收录 0/1 话');
});
