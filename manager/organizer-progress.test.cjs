const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {visibleFailures,loadDismissed,saveDismissed}=require('../js/job-notices.cjs');
function storage(){const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};}
test('initial preload and navigation share a request; failed loading can retry',async()=>{
 const source=fs.readFileSync(require.resolve('../js/organizer-desktop.cjs'),'utf8');
 const begin=source.indexOf('  async function load('),end=source.indexOf('  async function resume(',begin);
 let resolve,reject,calls=0;
 const context={ipc:{invoke(){calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});}},state:{loaded:false,jobs:new Map()},isActive:()=>true,notice:()=>{}};
 vm.createContext(context);vm.runInContext('let loading;'+source.slice(begin,end),context);
 const first=vm.runInContext('load({preload:true})',context),second=vm.runInContext('load()',context);
 assert.equal(calls,1);assert.equal(context.state.loaded,false);
 reject(Error('offline'));await assert.rejects(first,/offline/);await assert.rejects(second,/offline/);
 const retry=vm.runInContext('load()',context);resolve({tasks:[{uuid:'one'}],jobs:[]});await retry;
 assert.equal(calls,2);assert.equal(context.state.loaded,true);assert.equal(context.state.tasks[0].uuid,'one');
});
test('opening during skipped migration preload starts a normal load',async()=>{
 const source=fs.readFileSync(require.resolve('../js/organizer-desktop.cjs'),'utf8');
 const begin=source.indexOf('  async function load('),end=source.indexOf('  async function resume(',begin);
 let calls=0;
 const context={ipc:{invoke:async()=>++calls===1?null:{tasks:[],jobs:[]}},state:{loaded:false,jobs:new Map()},isActive:()=>true,notice:()=>{}};
 vm.createContext(context);vm.runInContext('let loading;'+source.slice(begin,end),context);
 await vm.runInContext('load({preload:true})',context);
 assert.equal(calls,2);assert.equal(context.state.loaded,true);
});
test('new failures show a close button, while active jobs retain progress and elapsed time',()=>{
 const source=fs.readFileSync(require.resolve('../js/organizer-desktop.cjs'),'utf8');const begin=source.indexOf('  function jobTitle('),end=source.indexOf('  async function load(',begin);
 const children=[];const host={replaceChildren(){children.length=0;},appendChild(el){children.push(el);}};
 const jobs=new Map([['old',{id:'old',task_id:'one',action:'deepseek-plan',state:'failed',error:'请求超时'}],['active',{id:'active',task_id:'two',action:'deepseek-plan',state:'running',progress:'第 1/2 批',clientStartedAt:Date.now()-5000}]]);
 function el(tag,cls,text){return {tag,cls,text,children:[],attributes:{},setAttribute(k,v){this.attributes[k]=v;},append(...items){this.children.push(...items);}};}
 const noticeStorage=storage(),dismissedJobs=new Set();const context={state:{jobs,screen:'tasks'},Date,visibleFailures,saveDismissed,dismissedJobs,historicalFailures:new Set(),noticeStorage,isActive:()=>true,container:()=>({querySelector:()=>host}),el,button:(text,fn)=>({...el('button','',text),onclick:fn})};
 vm.runInNewContext(source.slice(begin,end)+';updateJobs();',context);
 assert.equal(children.length,2);assert.match(children[0].text,/第 1\/2 批.*已等待/);assert.equal(children[0].attributes.role,'status');assert.match(children[1].children[0].text,/AI 辅助映射失败：请求超时/);assert.equal(children[1].attributes.role,'alert');
 children[1].children[1].onclick();assert.equal(children.length,1);assert.ok(dismissedJobs.has('old'));assert.ok(loadDismissed(noticeStorage).has('old'));
 vm.runInNewContext('updateJobs()',context);assert.equal(children.length,1);
});
test('a newer retry, including a queued retry, supersedes an older failure for the same task and action',()=>{
 const old={id:'old',task_id:'one',action:'deepseek-plan',state:'failed'};
 for(const state of ['queued','running','completed'])assert.equal(visibleFailures([old,{id:'new',task_id:'one',action:'deepseek-plan',state}]).length,0);
 assert.deepEqual(visibleFailures([old,{id:'new',task_id:'one',action:'deepseek-plan',state:'failed'}]).map(j=>j.id),['new']);
});
test('successful confirmation or recognition clears stale failure notices without clearing unrelated failures',()=>{
 const failed={id:'old',task_id:'one',action:'deepseek-plan',state:'failed'};
 for(const action of ['check','retry','execute'])assert.equal(visibleFailures([failed,{id:'ok',task_id:'one',action,state:'completed'}]).length,0);
 assert.equal(visibleFailures([failed,{id:'ok',task_id:'other',action:'check',state:'completed'}]).length,1);
 assert.equal(visibleFailures([failed,{id:'read',task_id:'one',action:'plan',state:'completed'}]).length,1);
});
test('historical and dismissed failures stay hidden; detail pages only show their own task failures',()=>{
 const jobs=[{id:'history',task_id:'one',action:'deepseek-plan',state:'failed'},{id:'dismiss',task_id:'one',action:'check',state:'failed'},{id:'new',task_id:'two',action:'check',state:'failed'}];
 assert.deepEqual(visibleFailures(jobs,{historical:new Set(['history']),dismissed:new Set(['dismiss'])}).map(j=>j.id),['new']);assert.equal(visibleFailures(jobs,{taskId:'other'}).length,0);
});
test('dismissed IDs survive reload with bounded storage and tolerate invalid or unavailable local storage',()=>{
 const store=storage();saveDismissed(store,new Set(Array.from({length:220},(_,i)=>String(i))));const restored=loadDismissed(store);assert.equal(restored.size,200);assert.equal(restored.has('0'),false);assert.equal(restored.has('219'),true);
 assert.equal(loadDismissed({getItem(){throw Error('unavailable');}}).size,0);assert.equal(loadDismissed({getItem:()=>'{broken'}).size,0);assert.doesNotThrow(()=>saveDismissed(undefined,new Set(['one'])));
});
