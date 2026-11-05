const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {SubtitleIndex,summary,summaryLabel}=require('../js/subtitle-index.cjs');
const {createScanContext}=require('../js/subtitle-index.cjs');
async function fixture(t,probeFile=async()=>[]){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-subs-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const index=new SubtitleIndex({directory,probeFile,resolveTool:async()=>({})});const video=path.join(directory,'Show.mkv');await fs.writeFile(video,'video');const work={EPDetails:{EP1:{Versions:[{path:video}]}}};return {directory,index,video,work};}
test('external matching prefers the longest video stem and rescans sidecars without reprobe',async t=>{let probes=0;const {directory,index,video,work}=await fixture(t,async()=>{probes++;return [];});await fs.writeFile(path.join(directory,'Show.01.mkv'),'video');await fs.writeFile(path.join(directory,'Show.01.chs.ass'),'subtitle');await index.scan(work);assert.equal(index.details(work).summary.covered,0);await fs.writeFile(path.join(directory,'Show.chs.ass'),'subtitle');await index.scan(work);assert.equal(index.details(work).summary.covered,1);assert.equal(probes,1);await fs.unlink(path.join(directory,'Show.chs.ass'));await index.scan(work);assert.equal(index.details(work).summary.uncertain,1);});
test('embedded tracks count as present and hardcoded subtitles require manual confirmation',async t=>{const {index,video,work}=await fixture(t,async()=>[{language:'zho',codec:'ass'}]);await index.scan(work);assert.equal(index.details(work).summary.covered,1);assert.match(index.details(work).files[0].label,/内封/);const other=await fixture(t);await other.index.scan(other.work);assert.equal(other.index.details(other.work).summary.status,'unconfirmed');await other.index.mark(other.video,'burned');assert.equal(other.index.details(other.work).summary.status,'complete');await other.index.mark(other.video,'none');assert.equal(other.index.details(other.work).summary.status,'missing');});
test('changed files invalidate track cache and manual declarations',async t=>{let probes=0;const {index,video,work}=await fixture(t,async()=>{probes++;return [];});await index.scan(work);await index.mark(video,'burned');await fs.writeFile(video,'replacement-video');await index.scan(work);assert.equal(probes,2);assert.equal(index.details(work).files[0].manual,undefined);assert.equal(index.details(work).summary.status,'unconfirmed');});
test('probe errors and offline files stay unknown, with manual evidence preserved across disconnects',async t=>{const {index,video,work}=await fixture(t,async()=>{throw Error('probe failed');});await index.scan(work);assert.equal(index.details(work).summary.status,'unknown');await index.mark(video,'burned');assert.equal(index.details(work).summary.status,'complete');const saved=video+'.offline';await fs.rename(video,saved);await index.scan(work);assert.equal(index.details(work).summary.status,'unknown');await fs.rename(saved,video);await index.scan(work);assert.equal(index.details(work).summary.status,'complete');});
test('one subtitled version covers a chapter, and per-file results survive reload',async t=>{const {directory,index,video,work}=await fixture(t);const alt=path.join(directory,'Alt.mkv');await fs.writeFile(alt,'video');work.EPDetails.EP1.Versions.push({path:alt});await fs.writeFile(path.join(directory,'Alt.srt'),'subtitle');await index.scan(work);assert.equal(index.details(work).summary.covered,1);const loaded=new SubtitleIndex({directory});await loaded.load();assert.equal(loaded.details(work).summary.covered,1);assert.match(summaryLabel(loaded.details(work).summary),/全剧有字幕/);});
test('shared media probes retain duration without changing subtitle detection',async t=>{const {directory,index,work}=await fixture(t,async()=>({internal:[{codec:'ass',language:'zho'}],durationSeconds:1423}));await index.scan(work);assert.equal(index.details(work).summary.covered,1);assert.equal(index.details(work).files[0].durationSeconds,1423);const loaded=new SubtitleIndex({directory});await loaded.load();assert.equal(loaded.details(work).files[0].durationSeconds,1423);});

test('a batch reads shared subtitle directories once and the next scan sees newly added sidecars',async t=>{
 const {directory,index,video,work}=await fixture(t);const files=[video];for(let n=1;n<48;n++){const f=path.join(directory,'Show EP'+n+'.mkv');await fs.writeFile(f,'video');files.push(f);}let reads=0;
 const context=createScanContext({readDirectory:async(...args)=>{reads++;return fs.readdir(...args);}});await index.scanFiles(files,{context});assert.equal(reads,3);
 await fs.mkdir(path.join(directory,'Subs'));await fs.writeFile(path.join(directory,'Subs','Show.chs.ass'),'subtitle');await index.scan(work);assert.equal(index.details(work).summary.covered,1);
});

test('sidecar-only refresh skips probes and later full detection still probes unknown tracks',async t=>{
 let probes=0;const {directory,index,video,work}=await fixture(t,async()=>{probes++;return [];});await fs.writeFile(path.join(directory,'Show.ass'),'subtitle');
 await index.scanFiles([video],{externalOnly:true});assert.equal(probes,0);assert.equal(index.details(work).summary.covered,1);assert.equal(index.details(work).files[0].state,'unprobed');
 await fs.unlink(path.join(directory,'Show.ass'));await index.scan(work);assert.equal(probes,1);assert.equal(index.details(work).summary.uncertain,1);
});

test('imported sidecars refresh while a background probe waits and survive its stale directory snapshot',async t=>{
 let release,started;const began=new Promise(r=>started=r),blocked=new Promise(r=>release=r);const {directory,index,video,work}=await fixture(t,async()=>{started();await blocked;return [];});
 const scanning=index.scan(work);await began;await fs.writeFile(path.join(directory,'Show.chs.ass'),'subtitle');
 try{await Promise.race([index.scanFiles([video],{externalOnly:true}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('sidecar refresh waited for full probe')),1000);timer.unref();})]);assert.equal(index.details(work).summary.covered,1);}finally{release();await scanning;}
 assert.equal(index.details(work).summary.covered,1);assert.equal(index.details(work).files[0].state,'checked');
});

test('longer video names also prevent false subtitle matches in Subs',async t=>{
 const {directory,index,work}=await fixture(t);await fs.writeFile(path.join(directory,'Show.01.mkv'),'video');await fs.mkdir(path.join(directory,'Subs'));await fs.writeFile(path.join(directory,'Subs','Show.01.chs.ass'),'subtitle');await index.scan(work);assert.equal(index.details(work).summary.covered,0);
});

test('all-library scan coalesces checkpoint writes instead of saving once every 25 files',async t=>{
 const {index}=await fixture(t);let saves=0;const save=index.save.bind(index);index.save=()=>{saves++;return save();};index.inspect=async()=>{};
 const work={ExistCondition:'Exist',EPDetails:{}};for(let n=0;n<60;n++)work.EPDetails['EP'+n]={AbsolutePath:path.resolve('fake-'+n+'.mkv')};
 const finished=new Promise(resolve=>{index.onProgress=progress=>{if(!progress.running)resolve();};});index.startAll({work});await finished;assert.equal(index.progress.done,60);assert.equal(saves,1);
});

test('concurrent saves persist the latest update even if a write is already in flight',async t=>{
 const {directory,index}=await fixture(t);const write=fs.writeFile;let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let writes=0;
 fs.writeFile=async(...args)=>{if(args[0]===index.filename+'.tmp'){writes++;if(writes===1){entered();await gate;}}return write(...args);};
 try{index.index.set('first',{path:'one'});const a=index.save();await started;index.index.set('second',{path:'two'});const b=index.save();release();await Promise.all([a,b]);}finally{release();fs.writeFile=write;}
 const saved=JSON.parse(await fs.readFile(path.join(directory,'subtitle-index.json'),'utf8'));assert.ok(saved.files.second);assert.equal(writes,2);
});
