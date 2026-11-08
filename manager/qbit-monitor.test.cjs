'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {DownloadMonitor,selectedFiles,QbitClient}=require('../js/qbit-monitor.cjs');

test('waiting, disconnect, moving, partial selection and restart deliver one review job',async()=>{
  const hash='a'.repeat(40),root=path.resolve('qbit-fixture');
  const storage=new Map(),store={get:(key,fallback)=>storage.get(key)??fallback,
    set:(key,value)=>storage.set(key,structuredClone(value))};
  let torrent,offline=false,submissions=0;
  const files=[{name:'pack/01.mkv',priority:1,progress:1},{name:'pack/02.mkv',priority:0,progress:0}];
  const api={get:async route=>{
    if(offline)throw Error('offline');
    const value=route.includes('files?')?files:torrent?[torrent]:[];
    return {json:async()=>value};
  }};
  const organizer={action:async(name,body)=>{
    assert.equal(name,'recognize-torrent');assert.deepEqual(body.files,[path.join(root,'pack','01.mkv')]);
    submissions++;return {job_id:'job'};
  },request:async()=>({state:'completed',result:{task_id:'task'}})};
  function restart(){const monitor=new DownloadMonitor(store,organizer);monitor.api=api;return monitor;}
  let monitor=restart();
  monitor.track(hash,'Show');await new Promise(r=>setImmediate(r));
  monitor.track(hash,'Show again');await new Promise(r=>setImmediate(r));
  assert.equal(monitor.rows.length,1);assert.equal(monitor.rows[0].stage,'waiting');
  monitor.command(hash,'remove');assert.equal(monitor.rows.length,0);
  monitor.track(hash,'Show');await new Promise(r=>setImmediate(r));
  torrent={hash,name:'Show',save_path:root,state:'downloading',amount_left:50,progress:0.5,dlspeed:2500,eta:750};
  await monitor.poll();assert.equal(monitor.snapshot().rows[0].progress,0.5);
  assert.equal(monitor.snapshot().rows[0].eta,750);
  torrent.eta=8640000;await monitor.poll();assert.equal(monitor.snapshot().rows[0].eta,8640000);
  offline=true;await monitor.poll();assert.equal(monitor.snapshot().error,'offline');
  offline=false;
  Object.assign(torrent,{state:'moving',progress:1,amount_left:0});
  await monitor.poll();assert.equal(monitor.rows[0].stage,'downloading');
  monitor=restart();torrent.state='stoppedUP';await monitor.poll();
  assert.equal(monitor.rows[0].stage,'recognizing');
  await monitor.poll();monitor=restart();await monitor.poll();
  await monitor.poll();assert.equal(submissions,1);
  assert.equal(monitor.rows[0].taskId,'task');assert.equal(monitor.rows[0].stage,'ready');
});

test('incomplete selected files wait and paths outside the save folder are rejected',()=>{
  const info={save_path:path.resolve('.')};
  assert.equal(selectedFiles(info,[{name:'file.mkv',priority:1,progress:0.9}]),null);
  assert.throws(()=>selectedFiles(info,[{name:'../other.mkv',priority:1,progress:1}]));
  assert.throws(()=>new QbitClient({url:'https://example.org'},()=>''),/本机/);
});

test('unconfirmed requests can be cleared without removing confirmed downloads, and late additions recover',async()=>{
  const store={get:(_,fallback)=>fallback,set(){}};
  const monitor=new DownloadMonitor(store,{});
  let torrents=[],offline=false;
  monitor.api={get:async()=>{if(offline)throw Error('offline');return {json:async()=>torrents};}};
  monitor.rows=[{hash:'a',stage:'waiting',requestedAt:Date.now()-61000},
    {hash:'b',stage:'downloading'},{hash:'c',stage:'waiting',requestedAt:Date.now()}];
  offline=true;await monitor.poll();assert.equal(monitor.rows[0].stage,'waiting');
  offline=false;await monitor.poll();
  assert.deepEqual(monitor.rows.map(row=>row.stage),['unconfirmed','missing','waiting']);
  torrents=[{hash:'a',state:'downloading',progress:0.1}];
  await monitor.poll();assert.equal(monitor.rows[0].stage,'downloading');
  monitor.rows.push({hash:'d',stage:'unconfirmed'});
  monitor.command(undefined,'clear-unconfirmed');
  assert.deepEqual(monitor.rows.map(row=>row.hash),['a','b','c']);
  monitor.command('c','remove');await monitor.poll();
  assert.equal(monitor.rows.some(row=>row.hash==='c'),false);
});

test('download records follow actual review, execution, cancellation, deletion and backend failure',async()=>{
  let tasks=[{uuid:'task',plan_state:'pending'}],unavailable=false;
  const monitor=new DownloadMonitor({get:(_,fallback)=>fallback,set(){}},{request:async(method,route)=>{
    assert.equal(method,'GET');assert.equal(route,'tasks?summary=true');
    if(unavailable)throw Error('offline');return {tasks};
  }});
  monitor.rows=[{hash:'a',stage:'ready',taskId:'task'}];
  async function status(){await monitor.poll();return monitor.snapshot().rows[0];}
  assert.equal((await status()).libraryStatus,'pending');
  tasks[0].error='目标路径冲突';assert.equal((await status()).libraryStatus,'failed');
  tasks[0]={uuid:'task',plan_state:'completed'};
  assert.equal((await status()).libraryStatus,'imported');
  unavailable=true;assert.equal((await status()).libraryStatus,'unknown');
  assert.match(monitor.snapshot().rows[0].libraryError,/offline/);
  unavailable=false;tasks[0]={uuid:'task',plan_state:'cancelled',review_state:'cancelled'};
  assert.equal((await status()).libraryStatus,'cancelled');
  tasks=[];assert.equal((await status()).libraryStatus,'missing');
  tasks=[{uuid:'task'}];assert.equal((await status()).libraryStatus,'unknown');
});
