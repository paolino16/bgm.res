const {test}=require('node:test');const assert=require('node:assert/strict');
const {setPlanLocked,runPlanAI}=require('../js/plan-background.cjs');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test('AI waits in background, blocks duplicate submission, and does not navigate back after user leaves',async()=>{
 const wait=deferred(),pending=new Map(),task={uuid:'one',name:'Show'},notices=[];let current=true,applied=0,syncs=0;
 const options={pending,task,request:()=>wait.promise,isCurrent:()=>current,apply:()=>applied++,notify:message=>notices.push(message),sync:()=>syncs++};
 const running=runPlanAI(options);assert.equal(pending.has('one'),true);assert.match(notices[0],/后台/);
 await assert.rejects(runPlanAI(options),/重复提交/);current=false;wait.resolve({revision:'new'});await running;
 assert.equal(applied,0);assert.equal(pending.size,0);assert.equal(syncs,2);assert.match(notices.at(-1),/重新打开/);
});
test('AI applies to the still-current plan and releases read-only controls on success or failure',async()=>{
 for(const fail of [false,true]){const wait=deferred(),pending=new Map();let applied=0;const locks=[];
 const running=runPlanAI({pending,task:{uuid:'one'},request:()=>wait.promise,isCurrent:()=>true,apply:()=>applied++,notify(){},sync:()=>locks.push(pending.has('one'))});
 if(fail){wait.reject(Error('timeout'));await assert.rejects(running,/timeout/);}else{wait.resolve({});await running;}
 assert.equal(applied,fail?0:1);assert.deepEqual(locks,[true,false]);assert.equal(pending.size,0);}
});
test('locking mutations leaves navigation outside the selection and preserves pre-existing disabled state',()=>{
 const controls=[{disabled:false},{disabled:true}],navigation={disabled:false};let selector;
 const host={querySelectorAll(value){selector=value;return controls;}};
 setPlanLocked(host,true);setPlanLocked(host,true);assert.deepEqual(controls.map(c=>c.disabled),[true,true]);assert.equal(navigation.disabled,false);
 assert.match(selector,/plan-row-editor/);assert.doesNotMatch(selector,/summary|plan-file-filter|pager/);
 setPlanLocked(host,false);assert.deepEqual(controls.map(c=>c.disabled),[false,true]);
});
