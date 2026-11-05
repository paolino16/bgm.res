const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {create}=require('../js/subtitle-panel.cjs');
function fixture(t,options={}){
 const previous=global.Option;global.Option=class{constructor(text,value){this.textContent=text;this.value=value;}};t.after(()=>{global.Option=previous;});
 function node(tag,cls,text){return {tag,className:cls,textContent:text,children:[],dataset:{},isConnected:true,
  append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);return item;},replaceChildren(...items){this.children=items;},add(item){this.children.push(item);},setAttribute(name,value){this[name]=value;},
  querySelector(selector){return all(this).find(item=>(selector==='[data-subtitle-execute]'&&item.dataset?.subtitleExecute!==undefined)||(selector==='[data-subtitle-count]'&&item.dataset?.subtitleCount!==undefined))||null;}};}
 function all(root){return [root,...(root.children||[]).flatMap(all)];}
 const host=node('main'),calls=[],jobs=new Map(),video1=path.resolve('library/Show EP01.mkv'),video2=path.resolve('library/Show EP02.mkv');let selected=[path.resolve('subs/Show EP01.chs.ass'),path.resolve('subs/Show EP02.srt')],sequence=0;
 const report={summary:{total:2,covered:0},files:[]};
 const ipc={async invoke(channel,body){calls.push({channel,body});
  if(channel==='subtitles:scan'||channel==='subtitles:details')return report;
  if(channel==='organizer:pick')return selected;
  if(channel==='subtitles:context')return {tasks:[{id:'task1',files:[video1]},{id:'task2',files:[video2]}]};
  if(channel==='organizer:action'){const id='job'+(++sequence);if(options.failSecondImport&&body.action==='subtitle-execute'&&body.body.id==='task2'){jobs.set(id,{state:'failed',error:'测试导入失败'});return {job_id:id};}jobs.set(id,{state:'completed',result:body.action==='subtitle-preview'?{videos:[video1,video2],rows:(body.body.files||[body.body.folder]).map((source,i)=>({source,video:[video1,video2][i],suffix:'chs',reason:'按集数匹配'}))}:{message:'已导入',videos:body.body.rows.map(row=>row.video)}});return {job_id:id};}
  if(channel==='organizer:job')return jobs.get(body);
  throw Error('Unexpected IPC '+channel);
 }};
 const panel=create({ipc,node,button:(text,fn)=>{const el=node('button','',text);el.onclick=fn;return el;},notice:message=>{calls.push({channel:'notice',body:message});},refresh:async()=>{}});
 panel.mount({id:'WorkSaveNo1'},host);
 const button=text=>all(host).find(item=>item.tag==='button'&&item.textContent===text);
 return {calls,button,host,all,report,panel,setSelected:paths=>{selected=paths;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('multiple selected subtitle files use one batch preview and import completion does not rescan the work',async t=>{
 const f=fixture(t);await settle();await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 const previews=f.calls.filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-preview');assert.equal(previews.length,1);assert.deepEqual(previews[0].body.body.ids,['task1','task2']);assert.equal(previews[0].body.body.files.length,2);
 await f.button('确认并导入字幕').onclick();assert.equal(f.calls.filter(c=>c.channel==='subtitles:scan').length,0);assert.ok(f.calls.some(c=>c.channel==='subtitles:details'));assert.equal(f.calls.filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-execute').length,2);assert.match(f.calls.findLast(c=>c.channel==='notice').body,/已导入 2/);
});
test('canceling file selection retains the previous plan; selecting a new file invalidates it',async t=>{
 const f=fixture(t);await settle();await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();f.setSelected([]);await f.button('选择字幕文件').onclick();assert.ok(f.button('确认并导入字幕'));
 const one=path.resolve('other/Only EP01.ass');f.setSelected([one]);await f.button('选择字幕文件').onclick();assert.equal(f.button('确认并导入字幕'),undefined);await f.button('匹配预览').onclick();const preview=f.calls.findLast(c=>c.channel==='organizer:action');assert.deepEqual(preview.body.body.files,[one]);
});
test('pasting an individual subtitle path replaces the previous file selection',async t=>{
 const f=fixture(t);await settle();f.setSelected([path.resolve('selected.ass')]);await f.button('选择字幕文件').onclick();const input=f.all(f.host).find(item=>item['aria-label']==='字幕文件或目录');input.value=path.resolve('pasted EP01.srt');input.oninput();await f.button('匹配预览').onclick();const preview=f.calls.findLast(c=>c.channel==='organizer:action');assert.equal(preview.body.body.folder,input.value);assert.equal(preview.body.body.files,undefined);
});


test('opening subtitles reads cached results and scanning is an explicit action',async t=>{
 const f=fixture(t);await settle();assert.equal(f.calls.filter(c=>c.channel==='subtitles:details').length,1);assert.equal(f.calls.filter(c=>c.channel==='subtitles:scan').length,0);
 await f.button('检测本剧字幕').onclick();assert.equal(f.calls.filter(c=>c.channel==='subtitles:scan').length,1);
});
test('file filtering and searching use cached results without another IPC request',async t=>{
 const f=fixture(t);f.report.files=[{path:'D:/Show/EP01.mkv',internal:[{language:'zh',codec:'ass'}],state:'checked',label:'内封字幕'},{path:'D:/Show/EP02.mkv',state:'checked',manual:'none',label:'已确认无字幕'},{path:'D:/Show/EP03.mkv',state:'error',error:'无法读取'}];await settle();
 const count=()=>f.all(f.host).filter(n=>n.className==='subtitle-file').length;
 assert.equal(count(),3);const before=f.calls.length;const filter=f.all(f.host).find(n=>n['aria-label']==='筛选字幕检测状态');filter.value='present';filter.onchange();assert.equal(count(),1);
 filter.value='all';filter.onchange();const search=f.all(f.host).find(n=>n['aria-label']==='搜索字幕检测结果');search.value='EP02';search.oninput();assert.equal(count(),1);assert.equal(f.calls.length,before);
});
test('import with no selected target remains disabled and clearly reports skipped rows',async t=>{
 const f=fixture(t);await settle();assert.equal(f.button('匹配预览').disabled,true);await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 const targets=f.all(f.host).filter(n=>n.tag==='select'&&n.children?.some(c=>c.textContent==='跳过'));
 for(const control of targets){control.value='';control.onchange();}
 assert.equal(f.button('确认并导入字幕').disabled,true);assert.match(f.all(f.host).find(n=>n.dataset?.subtitleCount!==undefined).textContent,/将导入 0.*跳过 2/);
});
test('file status never presents failed or offline detection as a healthy subtitle result',()=>{
 const {fileStatus}=require('../js/subtitle-panel.cjs');assert.equal(fileStatus({state:'unavailable',internal:[{}]}),'error');assert.equal(fileStatus({manual:'burned'}),'present');assert.equal(fileStatus({manual:'none',state:'checked'}),'missing');assert.equal(fileStatus({state:'checked'}),'unknown');
});


test('partial import retains only uncompleted rows selected for retry',async t=>{
 const f=fixture(t,{failSecondImport:true});await settle();await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();await f.button('确认并导入字幕').onclick();
 assert.match(f.calls.findLast(c=>c.channel==='notice').body,/已完成 1 条/);
 assert.match(f.all(f.host).find(n=>n.dataset?.subtitleCount!==undefined).textContent,/将导入 1.*跳过 1/);
 assert.equal(f.button('确认并导入字幕').disabled,false);
});
