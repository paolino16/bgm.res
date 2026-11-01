const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {parseDuration,bangumiDuration,formatDuration,DurationIndex}=require('../js/media-duration.cjs');
const {normalized}=require('../js/rename-binding-core.cjs');
test('Bangumi seconds take priority, original formats are parsed, unknowns stay unknown',()=>{
 assert.equal(bangumiDuration({duration_seconds:1423,duration:'24m'}),1423);
 for(const [text,seconds]of [['00:23:43',1423],['23:43',1423],['24m',1440],['24分钟',1440],['1h 20m 3s',4803],['00:23:43.5',1423.5]])assert.equal(parseDuration(text),seconds);
 for(const text of ['', '未知', '24', '00:99:00', '0m'])assert.equal(parseDuration(text),null);
 assert.equal(bangumiDuration({duration_seconds:0,duration:'24min'}),1440);
 assert.equal(formatDuration(1423),'23:43');assert.equal(formatDuration(4803),'1:20:03');assert.equal(formatDuration(null),'');
});
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-duration-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=path.join(directory,'episode.mkv');await fs.writeFile(file,'media');return {directory,file};}
test('local metadata is cached across sessions and replaced media invalidates it',async t=>{
 const {directory,file}=await fixture(t);let probes=0;const options={directory,resolveTool:async()=>({}),probeFile:async()=>{probes++;return {durationSeconds:1400};}};
 const index=new DurationIndex(options);assert.deepEqual(await Promise.all([index.get(file),index.get(file)]),[1400,1400]);assert.equal(probes,1);
 const loaded=new DurationIndex(options);await loaded.load();assert.equal(await loaded.get(file),1400);assert.equal(probes,1);
 await fs.writeFile(file,'replacement media');assert.equal(await loaded.get(file),1400);assert.equal(probes,2);
 await fs.unlink(file);assert.equal(await loaded.get(file),null);
});
test('existing subtitle metadata duration is reused and broken media is not repeatedly probed',async t=>{
 const {directory,file}=await fixture(t),stat=await fs.stat(file),sharedIndex=new Map([[normalized(file),{signature:[stat.dev,stat.ino,stat.size,stat.mtimeMs].join(':'),durationSeconds:1234}]]);
 let probes=0;const index=new DurationIndex({directory,sharedIndex,resolveTool:async()=>({}),probeFile:async()=>{probes++;throw Error('bad media');}});
 assert.equal(await index.get(file),1234);assert.equal(probes,0);sharedIndex.clear();assert.equal(await index.get(file),null);assert.equal(await index.get(file),null);assert.equal(probes,1);
});
test('background local probes are limited to two concurrent files',async t=>{
 const {directory}=await fixture(t);let active=0,peak=0;const index=new DurationIndex({directory,resolveTool:async()=>({}),probeFile:async()=>{peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {durationSeconds:60};}});
 const files=await Promise.all(Array.from({length:8},async(_,i)=>{const file=path.join(directory,i+'.mkv');await fs.writeFile(file,'media');return file;}));
 assert.deepEqual(await Promise.all(files.map(file=>index.get(file))),Array(8).fill(60));assert.equal(peak,2);
});
