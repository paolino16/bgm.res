const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {create}=require('../js/subtitle-panel.cjs');
function fixture(t,options={}){
 const previous=global.Option;global.Option=class{constructor(text,value){this.textContent=text;this.value=value;}};t.after(()=>{global.Option=previous;});
 function node(tag,cls,text){return {tag,className:cls,textContent:text,children:[],dataset:{},isConnected:true,
  append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);return item;},replaceChildren(...items){this.children=items;},add(item){this.children.push(item);},setAttribute(name,value){this[name]=value;},
  setCustomValidity(value){this.validity=value;},reportValidity(){return !this.validity;},
  querySelector(selector){return all(this).find(item=>(selector==='[data-subtitle-execute]'&&item.dataset?.subtitleExecute!==undefined)||(selector==='[data-subtitle-count]'&&item.dataset?.subtitleCount!==undefined))||null;}};}
 function all(root){return [root,...(root.children||[]).flatMap(all)];}
 const host=node('main'),calls=[],jobs=new Map(),video1=path.resolve('library/Show EP01.mkv'),video2=path.resolve(options.twoVersions?'library/Show EP01 [Other].mkv':'library/Show EP02.mkv');let selected=[path.resolve('subs/Show EP01.chs.ass'),path.resolve('subs/Show EP02.srt')],sequence=0;
 const report={summary:{total:2,covered:0},files:[]};
 const ipc={async invoke(channel,body){calls.push({channel,body});
  if(channel==='subtitles:scan'||channel==='subtitles:details')return report;
  if(channel==='subtitles:mark'){for(const file of report.files)file.manual=body.value||undefined;return report;}
  if(channel==='subtitle-inbox:list')return [];
  if(channel==='subtitle-sources:local')return {files:[path.resolve('unpacked/Show EP01.ass')],folder:path.resolve('unpacked')};
  if(channel==='organizer:pick')return selected;
  if(channel==='subtitles:context'&&options.sameTask)return {tasks:[{id:'task1',files:[video1,video2]}]};
  if(channel==='subtitles:context')return {chapters:options.chapters,tasks:[{id:'task1',files:[video1]},{id:'task2',files:[video2]}]};
  if(channel==='organizer:action'&&body.action==='subtitle-versions'){const id='versions'+(++sequence);jobs.set(id,{state:'completed',result:{groups:options.version?[{id:'chs.old',suffix:'chs.old',token:'old-version',files:[{video:video1,path:video1.replace('.mkv','.chs.old.ass')}],videos:[video1],formats:['ASS']}]:[],videos:[video1,video2]}});return {job_id:id};}
  if(channel==='organizer:action'&&options.cancelRemove&&body.action==='subtitle-manage'&&body.body.mode==='remove')return {cancelled:true};
  if(channel==='organizer:action'){const id='job'+(++sequence);if(options.failSecondImport&&body.action==='subtitle-manage'){jobs.set(id,{state:'failed',error:'测试导入失败'});return {job_id:id};}jobs.set(id,{state:'completed',result:body.action==='subtitle-preview'?{videos:[video1,video2],rows:(body.body.files||[body.body.folder]).map((source,i)=>({source,video:options.twoVersions?'':[video1,video2][i],videos:options.autoMatch?[video1,video2]:undefined,candidates:options.twoVersions?[video1,video2]:[],suffix:options.mixedLanguage&&i===1?'cht':'chs',reason:'按集数匹配'}))}:{count:body.body.rows.length,message:'已导入',videos:body.body.rows.map(row=>row.video)}});return {job_id:id};}
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
 await f.button('确认并导入字幕').onclick();assert.equal(f.calls.filter(c=>c.channel==='subtitles:scan').length,0);assert.ok(f.calls.some(c=>c.channel==='subtitles:details'));assert.equal(f.calls.filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-manage').length,1);assert.match(f.calls.findLast(c=>c.channel==='notice').body,/已导入 2/);
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

test('subtitle file lists jump directly to a loaded page without another scan',async t=>{
 const f=fixture(t);f.report.files=Array.from({length:45},(_,index)=>({path:'D:/Show/EP'+String(index+1).padStart(2,'0')+'.mkv',state:'checked'}));
 await settle();const before=f.calls.length;
 const nav=f.all(f.host).find(item=>item['aria-label']==='字幕文件分页');
 const input=f.all(nav).find(item=>item.tag==='input');input.value='3';
 f.all(nav).find(item=>item.tag==='form').onsubmit({preventDefault(){}});
 assert.equal(f.all(f.host).filter(item=>item.className==='subtitle-file').length,5);
 assert.match(f.all(f.host).find(item=>item.className==='subtitle-file-path').textContent,/EP41/);
 assert.equal(f.calls.length,before);
});

test('subtitle import previews support page-number jumps without requesting a new preview',async t=>{
 const f=fixture(t);await settle();f.setSelected(Array.from({length:45},(_,index)=>path.resolve('subs/Show EP'+String(index+1).padStart(2,'0')+'.ass')));
 await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 const before=f.calls.length;
 const nav=f.all(f.host).find(item=>item['aria-label']==='字幕导入预览分页');
 const jump=f.all(nav).find(item=>item['aria-label']==='第 3 页');jump.onclick();
 assert.equal(f.all(f.host).filter(item=>item.className==='subtitle-import-row').length,5);
 assert.equal(f.calls.length,before);
});
test('import with no selected target remains disabled and clearly reports skipped rows',async t=>{
 const f=fixture(t);await settle();assert.equal(f.button('匹配预览').disabled,true);await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 const targets=f.all(f.host).filter(n=>n.dataset?.subtitleTarget!==undefined);
 for(const control of targets){control.checked=false;control.onchange();}
 assert.equal(f.button('确认并导入字幕').disabled,true);assert.match(f.all(f.host).find(n=>n.dataset?.subtitleCount!==undefined).textContent,/将导入 0.*跳过 2/);
});
test('file status never presents failed or offline detection as a healthy subtitle result',()=>{
 const {fileStatus}=require('../js/subtitle-panel.cjs');assert.equal(fileStatus({state:'unavailable',internal:[{}]}),'error');assert.equal(fileStatus({manual:'burned'}),'present');assert.equal(fileStatus({manual:'none',state:'checked'}),'missing');assert.equal(fileStatus({state:'checked'}),'unknown');
});


test('existing subtitle names warn and allow immediate import without a replacement option',async t=>{
 const f=fixture(t,{version:true});await settle();await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 const suffix=f.all(f.host).find(n=>n.tag==='input'&&n.value==='chs'&&n.type==='text'&&n.oninput);
 suffix.value='chs.old';suffix.oninput();
 assert.match(f.all(f.host).find(n=>n.dataset?.subtitleCount!==undefined).textContent,/目标重名.*直接替换/);
 assert.equal(f.button('确认并导入字幕').disabled,false);
 await f.button('确认并导入字幕').onclick();
 const imported=f.calls.findLast(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-manage');
 assert.equal(imported.body.body.mode,'add');assert.equal(imported.body.body.rows[0].suffix,'chs.old');
});

test('failed atomic import retains every selected row for retry',async t=>{
 const f=fixture(t,{failSecondImport:true});await settle();await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();await f.button('确认并导入字幕').onclick();
 assert.match(f.calls.findLast(c=>c.channel==='notice').body,/测试导入失败/);
 assert.match(f.all(f.host).find(n=>n.dataset?.subtitleCount!==undefined).textContent,/将导入 2.*跳过 0/);
 assert.equal(f.button('确认并导入字幕').disabled,false);
});

test('manual confirmation applies to the entire work outside filtering and has no per-file selector',async t=>{
 const f=fixture(t);f.report.files=Array.from({length:25},(_,i)=>({path:'D:/Show/EP'+i+'.mkv',state:'checked'}));await settle();
 const search=f.all(f.host).find(el=>el['aria-label']==='搜索字幕检测结果');search.value='EP0';search.oninput();
 const manual=f.all(f.host).find(el=>el['aria-label']==='全部视频的人工确认');manual.value='burned';
 assert.equal(f.all(f.host).filter(el=>el.tag==='select'&&String(el['aria-label']).startsWith('人工确认 ')).length,0);
 await f.button('确认全部').onclick();
 assert.deepEqual(f.calls.find(c=>c.channel==='subtitles:mark').body,{id:'WorkSaveNo1',all:true,value:'burned'});
 assert.ok(f.report.files.every(file=>file.manual==='burned'));
});

for(const sameTask of [true,false])test('one subtitle imports into both selected versions; same task='+sameTask,async t=>{
 const f=fixture(t,{twoVersions:true,sameTask});await settle();const source=path.resolve('subs/Show EP01.chs.ass');f.setSelected([source]);await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 assert.equal(f.button('确认并导入字幕').disabled,true);
 const targets=f.all(f.host).filter(n=>n.dataset?.subtitleTarget!==undefined);assert.equal(targets.length,2);
 for(const target of targets){target.checked=true;target.onchange();}
 assert.match(f.all(f.host).find(n=>n.dataset?.subtitleCount!==undefined).textContent,/将导入 2 份字幕（1 个源文件）.*跳过 0/);
 await f.button('确认并导入字幕').onclick();
 const imports=f.calls.filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-manage');assert.equal(imports.length,1);
 const rows=imports.flatMap(c=>c.body.body.rows);assert.equal(rows.length,2);assert.ok(rows.every(row=>row.source===source));assert.equal(new Set(rows.map(row=>row.video)).size,2);
});
test('failed multi-version transaction retains both targets and retries them together',async t=>{
 const f=fixture(t,{twoVersions:true,failSecondImport:true});await settle();f.setSelected([path.resolve('subs/Show EP01.chs.ass')]);await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 for(const target of f.all(f.host).filter(n=>n.dataset?.subtitleTarget!==undefined)){target.checked=true;target.onchange();}
 await f.button('确认并导入字幕').onclick();
 const targets=f.all(f.host).filter(n=>n.dataset?.subtitleTarget!==undefined);assert.equal(targets.filter(n=>n.checked).length,2);
 const before=f.calls.length;await f.button('确认并导入字幕').onclick();const retry=f.calls.slice(before).filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-manage');assert.equal(retry.length,1);assert.equal(retry[0].body.body.rows.length,2);
});

test('confirmed chapter context reaches preview and all matched versions start selected',async t=>{
 const chapters=[{id:'EP1',number:1,kind:'EP',videos:['registered']}];const f=fixture(t,{twoVersions:true,autoMatch:true,chapters});await settle();
 f.setSelected([path.resolve('subs/Show EP01.ass')]);await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 const preview=f.calls.find(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-preview');assert.deepEqual(preview.body.body.chapters,chapters);
 const targets=f.all(f.host).filter(n=>n.dataset?.subtitleTarget!==undefined);assert.equal(targets.filter(n=>n.checked).length,2);assert.equal(f.button('确认并导入字幕').disabled,false);
 targets[1].checked=false;targets[1].onchange();await f.button('确认并导入字幕').onclick();
 const imports=f.calls.filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-manage');assert.equal(imports.length,1);assert.equal(imports[0].body.body.rows.length,1);
});

test('download handoff previews the target work without executing an import',async t=>{
 const f=fixture(t);await settle();const files=[path.resolve('download/Show EP01.ass'),path.resolve('download/Show EP02.ass')];
 f.panel.prepare({id:'WorkSaveNo1'},files);f.host.replaceChildren();f.panel.mount({id:'WorkSaveNo1'},f.host);await settle();await settle();
 const previews=f.calls.filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-preview');assert.equal(previews.length,1);assert.deepEqual(previews[0].body.body.files,files);
 assert.equal(f.calls.filter(c=>c.channel==='organizer:action'&&c.body.action==='subtitle-manage').length,0);assert.ok(f.button('确认并导入字幕'));
 assert.ok(!f.all(f.host).some(item=>item.className==='subtitle-online'));
});
test('batch suffix preserves detected languages and repeated application does not append duplicates',async t=>{
 const f=fixture(t,{mixedLanguage:true});await settle();await f.button('选择字幕文件').onclick();await f.button('匹配预览').onclick();
 let group=f.all(f.host).find(el=>el['aria-label']==='批量字幕组');group.value='GroupB';group.oninput();f.button('应用字幕后缀').onclick();f.button('应用字幕后缀').onclick();
 await f.button('确认并导入字幕').onclick();const rows=f.calls.findLast(call=>call.channel==='organizer:action'&&call.body.action==='subtitle-manage').body.body.rows;assert.deepEqual(rows.map(row=>row.suffix),['chs.GroupB','cht.GroupB']);
});
test('cancelled removal does not poll a job, refresh or show an error',async t=>{
 const f=fixture(t,{version:true,cancelRemove:true});await settle();const before=f.calls.length;await f.button('移除字幕版本').onclick();const calls=f.calls.slice(before);assert.ok(calls.some(call=>call.channel==='organizer:action'&&call.body.action==='subtitle-manage'));assert.equal(calls.some(call=>['notice','organizer:job','subtitles:details'].includes(call.channel)),false);assert.ok(f.button('移除字幕版本'));
});
test('replacement opens all three source choices and accepts archive extraction',async t=>{
 const f=fixture(t,{version:true});await settle();const before=f.calls.length;f.button('替换字幕版本').onclick();assert.equal(f.calls.slice(before).some(call=>call.channel==='organizer:pick'),false);assert.ok(f.button('选择字幕文件'));assert.ok(f.button('选择字幕压缩包'));assert.ok(f.button('选择目录'));
 f.setSelected([path.resolve('package.zip')]);await f.button('选择字幕压缩包').onclick();await f.button('匹配预览').onclick();const preview=f.calls.findLast(call=>call.channel==='organizer:action'&&call.body.action==='subtitle-preview');assert.deepEqual(preview.body.body.files,[path.resolve('unpacked/Show EP01.ass')]);await f.button('确认并导入字幕').onclick();const execute=f.calls.findLast(call=>call.channel==='organizer:action'&&call.body.action==='subtitle-manage');assert.equal(execute.body.body.mode,'replace');assert.equal(execute.body.body.token,'old-version');
});
test('replacement accepts a directory while retaining the selected old version',async t=>{
 const f=fixture(t,{version:true});await settle();f.button('替换字幕版本').onclick();const folder=path.resolve('new-subs');f.setSelected([folder]);await f.button('选择目录').onclick();await f.button('匹配预览').onclick();const preview=f.calls.findLast(call=>call.channel==='organizer:action'&&call.body.action==='subtitle-preview');assert.equal(preview.body.body.folder,folder);await f.button('确认并导入字幕').onclick();assert.equal(f.calls.findLast(call=>call.channel==='organizer:action'&&call.body.action==='subtitle-manage').body.body.mode,'replace');
});
