'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {service}=require('../js/subtitle-sources-main.cjs');
function fixture(run){
  let clock=1000;const calls=[],stored=new Map();
  const store={get:key=>stored.get(key),set:(key,value)=>stored.set(key,value),delete:key=>stored.delete(key)};
  const encryption={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('sealed:'+value),decryptString:value=>value.toString().slice(7)};
  const client=service({store,safeStorage:encryption,directory:'fixture',now:()=>clock,sleep:async ms=>{clock+=ms;},
    run:async args=>{calls.push({...args,time:clock});return run(args,calls.length);}});
  return {client,calls,stored,encryption,advance:ms=>{clock+=ms;}};
}
test('tokens remain encrypted in storage and never appear in public settings',()=>{
  const f=fixture(()=>({value:{}}));f.client.configure('A'.repeat(32));
  assert.equal(f.stored.get('subtitles.assrtToken'),Buffer.from('sealed:'+'A'.repeat(32)).toString('base64'));
  assert.equal(JSON.stringify(f.client.settings()).includes('AAAA'),false);
  f.encryption.isEncryptionAvailable=()=>false;f.client.configure('B'.repeat(32));assert.equal(f.client.settings().persisted,false);
  f.client.configure('');assert.equal(f.client.settings().configured,false);
});
test('concurrent identical searches share a request and completed searches are cached',async()=>{
  const f=fixture(()=>({value:{rows:[],next:null}}));
  await Promise.all([f.client.search({source:'acgrip',query:'test'}),f.client.search({source:'acgrip',query:'test'})]);
  await f.client.search({source:'acgrip',query:'test'});assert.equal(f.calls.length,1);
  f.advance(300001);await f.client.search({source:'acgrip',query:'test'});assert.equal(f.calls.length,2);
});
test('assrt requests share one paced queue',async()=>{
  const f=fixture(()=>({value:{rows:[],next:null}}));f.client.configure('A'.repeat(32));
  await Promise.all(['one','two','three'].map(query=>f.client.search({source:'assrt',query})));
  assert.ok(f.calls[1].time-f.calls[0].time>=3500);assert.ok(f.calls[2].time-f.calls[1].time>=3500);
  assert.ok(f.calls.every(call=>call.token==='A'.repeat(32)));
});
test('API cooldown blocks only assrt and does not cache a waiting response',async()=>{
  const f=fixture((args,count)=>count===1?{error:'limited',code:'rate_limit',retryAfter:60}:{value:{rows:[],next:null}});
  f.client.configure('A'.repeat(32));const request={source:'assrt',query:'title'};
  const limited=await f.client.search(request);assert.equal(limited.waiting,true);
  const again=await f.client.search({...request,query:'different'});assert.equal(again.waiting,true);assert.equal(f.calls.length,1);
  assert.deepEqual(await f.client.search({source:'acgrip',query:'title'}),{rows:[],next:null});
  f.advance(60001);assert.deepEqual(await f.client.search(request),{rows:[],next:null});assert.equal(f.calls.length,3);
});
test('download accepts only previously parsed attachments and ignores renderer URLs',async()=>{
  const file={id:'42',entryId:'13925',postId:'11',name:'test.7z',source:'acgrip'};
  const f=fixture(args=>({value:args.action==='detail'?{posts:[{id:'11',files:[file]}]}:{folder:'D:/fixture/uuid',files:['D:/fixture/uuid/01.ass']}}));
  const request={source:'acgrip',id:'13925',postId:'11',fileId:'42',url:'http://localhost/secret'};
  assert.throws(()=>f.client.download(request),/先展开/);
  await f.client.detail({source:'acgrip',id:'13925',cursor:2});await f.client.download(request);
  assert.equal(f.calls[1].url,undefined);assert.equal(f.calls[1].page,2);assert.deepEqual(f.calls[1].file,file);
});
test('configuration changes invalidate cached API results',async()=>{
  const f=fixture(()=>({value:{rows:[],next:null}}));f.client.configure('A'.repeat(32));
  await f.client.search({source:'assrt',query:'test'});f.client.configure('B'.repeat(32));await f.client.search({source:'assrt',query:'test'});
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].token,'B'.repeat(32));
});
test('invalid API token errors are actionable and do not become waiting states',async()=>{
  const f=fixture(()=>({error:'射手网 Token 无效，请重新配置',code:'token'}));f.client.configure('A'.repeat(32));
  await assert.rejects(f.client.search({source:'assrt',query:'test'}),/Token 无效/);
});
test('local subtitle packages use isolated extraction without provider credentials',async()=>{const f=fixture(args=>({value:{folder:'D:/fixture/local',archive:'D:/fixture/local/test.zip',files:['D:/fixture/local/files/01.ass']}}));const result=await f.client.local({archive:'D:/selected/test.zip',workId:'work',workName:'Show'});assert.equal(f.calls[0].action,'extract-local');assert.equal(f.calls[0].archive,'D:/selected/test.zip');assert.equal(f.calls[0].token,undefined);assert.equal(result.files.length,1);await assert.rejects(f.client.local({archive:'D:/selected/video.mkv'}),/ZIP/);});
