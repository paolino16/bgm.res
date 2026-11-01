const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {progress}=require('../js/home-progress.cjs');const {BangumiNetwork}=require('../js/bangumi-network.cjs');
test('home without recent history has finite zero progress and never queries null work',()=>{
  const store={find(){throw Error('must not read absent work');}};for(const id of [null,undefined,'',false])assert.equal(progress(store,id),0);
  assert.equal(progress({find:k=>k.endsWith('EPTrueNum')?0:false},'1'),0);
  assert.equal(progress({find:k=>k.endsWith('EPTrueNum')?2:k.includes('EP1.')?'Watched':'Unwatched'},'1'),50);
});
function fakeNet(handler){return {request(options){const req=new EventEmitter();req.headers={};req.setHeader=(k,v)=>req.headers[k]=v;req.write=b=>req.body=b;req.abort=()=>{};req.end=()=>setImmediate(()=>{
  try{const r=handler(options,req);const response=new EventEmitter();response.statusCode=r.status||200;req.emit('response',response);setImmediate(()=>{response.emit('data',Buffer.from(r.body));response.emit('end');});}catch(e){req.emit('error',e);}
});return req;}};}
test('public metadata and artwork cache survive network failure; authenticated requests never cache',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-network-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));let online=true,calls=0;
  const net=fakeNet((o)=>{calls++;if(!online)throw Error('offline');return {body:o.url.includes('lain.bgm.tv')?'image bytes':JSON.stringify({images:{large:'https://lain.bgm.tv/pic/cover/l/test.jpg'},name:'Title'})};});
  const network=new BangumiNetwork({net,directory:dir});const options={url:'https://api.bgm.tv/v0/subjects/42'};
  const r=await network.request(options);assert.match(JSON.parse(r.body).images.large,/^file:\/\//);assert.equal(calls,2);
  online=false;assert.equal((await network.request(options)).cached,true);assert.equal(calls,2);
  await assert.rejects(network.request({...options,headers:{Authorization:'Bearer test-token'}}),/offline/);assert.equal(calls,3);
  await assert.rejects(network.request({url:'https://example.com/'}),/只允许/);
});
test('API transport uses the shared channel for subject details and preserves HTTP errors',async()=>{
  let transport;const $={ajaxPrefilter(){},ajaxTransport(_,fn){transport=fn;}};const {install}=require('../js/rename-binding-renderer.cjs');
  let passed;install({$,store:{get:()=>({})},ipc:{invoke:async(channel,o)=>{passed={channel,...o};return {status:404,body:'{}'};}}});
  const result=await new Promise(r=>transport({url:'https://api.bgm.tv/v0/subjects/42',type:'GET'}).send({},(...args)=>r(args)));
  assert.equal(passed.channel,'bangumi:request');assert.equal(result[0],404);assert.equal(transport({url:'https://example.com/'}),undefined);
});
