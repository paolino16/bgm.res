const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {BangumiNetwork}=require('../js/bangumi-network.cjs');
test('detail reads stale disk metadata immediately; explicit refresh replaces the snapshot',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-detail-cache-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const url='https://api.bgm.tv/v0/subjects/12/persons',folder=path.join(directory,'metadata-cache');await fs.mkdir(folder);
  const filename=path.join(folder,createHash('sha256').update(url).digest('hex')+'.json');
  await fs.writeFile(filename,JSON.stringify({saved:Date.now()-3600000,body:'[{"name":"old"}]'}));
  const network=new BangumiNetwork({directory});let calls=0;
  network.raw=async()=>{calls++;return {status:200,body:'[{"name":"new"}]'};};
  const cached=await network.request({url,preferCached:true});assert.equal(cached.stale,true);assert.equal(calls,0);assert.equal(JSON.parse(cached.body)[0].name,'old');
  await network.request({url});assert.equal(calls,1);
  const fresh=await network.request({url,preferCached:true});assert.equal(fresh.stale,undefined);assert.equal(JSON.parse(fresh.body)[0].name,'new');assert.equal(calls,1);
});
test('cold detail fetches normally and failed refresh retains stale disk metadata',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-detail-cache-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const network=new BangumiNetwork({directory}),url='https://api.bgm.tv/v0/subjects/12/persons';let calls=0;
  network.raw=async()=>{calls++;return {status:200,body:'[]'};};
  assert.equal((await network.request({url,preferCached:true})).status,200);assert.equal(calls,1);
  const filename=path.join(directory,'metadata-cache',createHash('sha256').update(url).digest('hex')+'.json');
  const stored=JSON.parse(await fs.readFile(filename,'utf8'));stored.saved=0;await fs.writeFile(filename,JSON.stringify(stored));
  network.raw=async()=>{throw Error('offline');};
  assert.equal((await network.request({url})).stale,true);
  assert.equal((await network.request({url,preferCached:true})).body,'[]');
});
