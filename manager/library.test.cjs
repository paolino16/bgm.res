const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Library,hint}=require('./library.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-library-'));const lib=new Library(path.join(dir,'test.sqlite'));t.after(async()=>{lib.close();await fs.rm(dir,{recursive:true,force:true});});return {dir,lib};}
test('imports exact episode IDs, preserves versions and manual edits on reimport',async t=>{
  const {dir,lib}=await fixture(t);await fs.mkdir(path.join(dir,'task'));await fs.mkdir(path.join(dir,'record'));
  const a=path.join(dir,'Show EP23 [A].mkv'),b=path.join(dir,'Show EP23 [B].mkv');await fs.writeFile(a,'a');await fs.writeFile(b,'b');
  await fs.writeFile(path.join(dir,'task','one.json'),JSON.stringify({uuid:'one',name:'Show',subject_id:'42',episode_bindings:[{source:'source-a',subject_id:'42',episode_id:2300,episode:23,episode_type:0},{source:'source-b',subject_id:'42',episode_id:2300,episode:23,episode_type:0}]}));
  await fs.writeFile(path.join(dir,'record','one.json'),JSON.stringify({entries:{'source-a':{target:a},'source-b':{target:b}}}));
  await lib.importRename(dir);await lib.check();let s=lib.list().subjects[0];assert.equal(s.files.length,2);assert.equal(s.files[0].episode_id,'2300');assert.equal(s.files[0].status,'available');const ids=s.files.map(f=>f.id).sort();
  lib.db.prepare('INSERT INTO episodes VALUES(?,?,?,?,?)').run('2301','bgm:42','24',0,'next');lib.bind(s.files[0].id,'bgm:42','2301');
  await lib.importRename(dir);s=lib.list().subjects[0];assert.deepEqual(s.files.map(f=>f.id).sort(),ids);assert.equal(s.files.find(f=>f.id===ids[0])?.id,ids[0]);assert.equal(s.files.filter(f=>f.binding==='manual')[0].episode_id,'2301');
  assert.throws(()=>lib.bind(s.files[0].id,'bgm:99','2301'),/不属于/);
});
test('filename hints keep decimal and absolute numbering unconfirmed; scanning preserves explicit bindings',async t=>{
  const {dir,lib}=await fixture(t);assert.equal(hint('Show EP12.5.mkv').number,'12.5');assert.equal(hint('Show S02E23.mkv').number,'23');
  const root=path.join(dir,'media'),show=path.join(root,'Show (2020)');await fs.mkdir(show,{recursive:true});const file=path.join(show,'Show EP23.mkv');await fs.writeFile(file,'video');
  await lib.scan(root);let s=lib.list().subjects[0];assert.equal(s.files[0].episode_id,null);assert.equal(s.files[0].episode_number,'23');
  const sid=lib.subject('42','Show','2020');lib.file(sid,file,{subject_id:'42',episode_id:'99',episode:23,episode_type:0},'rename');await lib.scan(root);assert.equal(lib.list().subjects.find(s=>s.id===sid).files[0].episode_id,'99');
  await fs.unlink(file);await lib.check();assert.equal(lib.list().subjects.find(s=>s.id===sid).files[0].status,'missing');assert.equal(lib.list().subjects.find(s=>s.id===sid).files.length,1);
});
test('malformed import is reported, planned targets without records are not indexed',async t=>{
  const {dir,lib}=await fixture(t);await fs.mkdir(path.join(dir,'task'));await fs.mkdir(path.join(dir,'record'));await fs.writeFile(path.join(dir,'task','bad.json'),'{');await fs.writeFile(path.join(dir,'task','planned.json'),JSON.stringify({name:'planned',output_dir:dir}));const r=await lib.importRename(dir);assert.equal(r.errors.length,2);assert.equal(lib.list().subjects.length,0);
});
test('API rejects untrusted writes and path traversal',async t=>{
  const {start}=require('./server.cjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-server-'));const s=await start({dataDir:dir});t.after(async()=>{await s.close();await fs.rm(dir,{recursive:true,force:true});});
  assert.equal((await fetch(s.url+'/api/check',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(s.url+'/library.cjs')).status,404);
  const page=await(await fetch(s.url)).text();const token=page.match(/name="library-token" content="([^"]+)"/)[1];const r=await fetch(s.url+'/api/library',{headers:{'X-Library-Token':token}});assert.equal(r.status,200);assert.deepEqual((await r.json()).subjects,[]);
});
test('confirmed extras survive reimport and metadata failures leave the old catalog intact',async t=>{
  const {dir,lib}=await fixture(t);const sid=lib.subject('42','Original','2020');const video=path.join(dir,'PV.mkv');lib.file(sid,video);let f=lib.list().subjects[0].files[0];lib.classifyExtra(f.id);lib.file(sid,video,{subject_id:'42',episode_id:123,episode:1,episode_type:0},'rename');f=lib.list().subjects[0].files[0];assert.equal(f.binding,'manual-extra');assert.equal(f.episode_id,null);
  lib.db.prepare('INSERT INTO episodes VALUES(?,?,?,?,?)').run('old',sid,'1',0,'Original chapter');const originalFetch=global.fetch;t.after(()=>global.fetch=originalFetch);let calls=0;
  global.fetch=async()=>{calls++;if(calls===1)return {ok:true,json:async()=>({type:2,name:'New title',images:{},date:'2021-01-01'})};if(calls===2)return {ok:true,json:async()=>({data:[{id:900,type:0,sort:1,name:'new'}],total:2})};throw Error('network interrupted');};
  await assert.rejects(lib.metadata(sid,'42'),/network interrupted/);const s=lib.list().subjects[0];assert.equal(s.title,'Original');assert.equal(s.episodes[0].id,'old');
});
test('conflicting source records cannot silently reassign the same output file',async t=>{
  const {dir,lib}=await fixture(t);await fs.mkdir(path.join(dir,'task'));await fs.mkdir(path.join(dir,'record'));const target=path.join(dir,'same.mkv');
  for(const [name,bgm] of [['a','42'],['b','43']]){await fs.writeFile(path.join(dir,'task',name+'.json'),JSON.stringify({name,subject_id:bgm}));await fs.writeFile(path.join(dir,'record',name+'.json'),JSON.stringify({source:{target}}));}
  const result=await lib.importRename(dir);assert.equal(result.files,0);assert.equal(result.errors.length,1);assert.equal(lib.list().subjects.length,0);
});
