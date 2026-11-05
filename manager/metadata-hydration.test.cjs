const {test}=require('node:test');const assert=require('node:assert/strict');
const {create}=require('../js/metadata-hydration.cjs');
function harness(network){const data={},reports=[];let queue=Promise.resolve(),notifications=0;const service=create({data,network,save:async()=>{},thumbnails:{prepare:async()=>{}},transaction:fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;},notify:()=>notifications++,report:async r=>reports.push(r)});return {data,reports,service,notifications:()=>notifications};}
test('a later import hydrates new covers and keeps watch edits made during the fetch',async()=>{
 let release,started;const waiting=new Promise(r=>started=r);let calls=0;
 const h=harness({request:async()=>{calls++;started();await new Promise(r=>release=r);return {status:200,body:JSON.stringify({images:{large:'file:///cover.jpg'},name_cn:'作品',rating:{score:8}})};}});
 await h.service.hydrate();h.data.one={RenameBinding:{},bgmID:'42',Cover:'./assets/banner.jpg',EPDetails:{EP1:{Condition:'Unwatched'}}};
 const pending=h.service.hydrate();await waiting;h.data.one={...h.data.one,EPDetails:{EP1:{Condition:'Watched'}}};release();await pending;
 assert.equal(h.data.one.Cover,'file:///cover.jpg');assert.equal(h.data.one.EPDetails.EP1.Condition,'Watched');assert.equal(calls,1);assert.ok(h.notifications());
 await h.service.hydrate();assert.equal(calls,1);
});
test('import during hydration is picked up without duplicate concurrent requests',async()=>{
 let release,started;const waiting=new Promise(r=>started=r);const calls=[];
 const h=harness({request:async({url})=>{calls.push(url);if(calls.length===1){started();await new Promise(r=>release=r);}return {status:200,body:JSON.stringify({images:{large:'file:///cover.jpg'}})};}});
 h.data.one={RenameBinding:{},bgmID:'1'};const first=h.service.hydrate();await waiting;h.data.two={RenameBinding:{},bgmID:'2'};const second=h.service.hydrate();release();await Promise.all([first,second]);assert.equal(calls.length,2);assert.ok(h.data.two.Cover);
});
test('fetch failure keeps metadata and can be retried on a later refresh',async()=>{
 let fail=true;const h=harness({request:async()=>{if(fail)throw Error('offline');return {status:200,body:'{"images":{"large":"cover"}}'};}});h.data.one={RenameBinding:{},bgmID:'42',Name:'original'};
 await h.service.hydrate();assert.equal(h.data.one.Name,'original');assert.equal(h.reports[0].errors.length,1);fail=false;await h.service.hydrate();assert.equal(h.data.one.Cover,'cover');
});
test('date backfill uses cached metadata and preserves an existing cover and local title',async()=>{
 const h=harness({cachedSubject:async id=>({date:'2024-04-06',name_cn:'remote',images:{large:'remote-cover'}}),request:async()=>{throw Error('must use local metadata');}});
 h.data.one={RenameBinding:{},bgmID:'42',Cover:'file:///custom.jpg',Name:'local',Year:'0000'};await h.service.hydrate();assert.equal(h.data.one.AirDate,'2024-04-06');assert.equal(h.data.one.Year,'2024');assert.equal(h.data.one.Name,'local');assert.equal(h.data.one.Cover,'file:///custom.jpg');
});
test('unpublished dates remain unknown without repeated fetches on every refresh',async()=>{
 let calls=0;const h=harness({request:async()=>{calls++;return {status:200,body:'{"date":null}'};}});h.data.one={RenameBinding:{},bgmID:'42',Cover:'file:///existing.jpg',Year:'2027'};await h.service.hydrate();await h.service.hydrate();assert.equal(calls,1);assert.equal(h.data.one.AirDate,'');assert.equal(h.data.one.Year,'2027');
});

test('rank backfill uses cached subject data even when artwork and date already exist',async()=>{
 let calls=0;const h=harness({cachedSubject:async()=>{calls++;return {date:'2024-04-06',rating:{rank:123,score:8}};},request:async()=>{throw Error('must use cache');}});
 h.data.one={RenameBinding:{},bgmID:'42',Cover:'file:///custom.jpg',Name:'local',AirDate:'2024-04-06',AirDateChecked:true,Score:8,EPDetails:{EP1:{Condition:'Watched'}}};
 await h.service.hydrate();assert.equal(h.data.one.Rank,123);assert.equal(h.data.one.RankChecked,true);assert.equal(h.data.one.Name,'local');assert.equal(h.data.one.EPDetails.EP1.Condition,'Watched');await h.service.hydrate();assert.equal(calls,1);
});
test('unranked subjects do not show zero rank or retry on every hydration',async()=>{
 for(const rank of [0,null,undefined,-1,1.5]){let calls=0;const h=harness({cachedSubject:async()=>{calls++;return {rating:{rank}};}});h.data.one={RenameBinding:{},bgmID:'42',Cover:'file:///cover.jpg',AirDateChecked:true};await h.service.hydrate();await h.service.hydrate();assert.equal(h.data.one.Rank,null);assert.equal(h.data.one.RankChecked,true);assert.equal(calls,1);}
});
