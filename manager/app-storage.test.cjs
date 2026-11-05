const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {resolveStorage}=require('../js/app-storage.cjs');
test('desktop launch uses the existing canonical data location rather than a fresh APPDATA directory',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-storage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const engine=path.join(root,'engine'),data=path.join(root,'canonical','bgm.res-linked','rename');await fs.mkdir(engine,{recursive:true});await fs.mkdir(path.join(data,'task'),{recursive:true});await fs.writeFile(path.join(engine,'.bgm-storage.json'),JSON.stringify({renameData:data}));
 const resolved=resolveStorage({project:root,appData:path.join(root,'other-appdata'),env:{BGM_RENAME_PROJECT:engine,BGM_RES_DATA_DIR:path.join(root,'empty')}});assert.equal(resolved.directory,path.dirname(data));assert.equal(resolved.renameData,data);
 await fs.writeFile(path.join(engine,'.bgm-storage.json'),JSON.stringify({renameData:path.join(root,'missing','rename')}));assert.throws(()=>resolveStorage({project:root,appData:root,env:{BGM_RENAME_PROJECT:engine}}),/不可访问/);
});
test('a new installation without a storage pointer uses its configured app directory',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-storage-new-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const directory=path.join(root,'user-data');assert.equal(resolveStorage({project:root,appData:root,env:{BGM_RENAME_PROJECT:path.join(root,'engine'),BGM_RES_DATA_DIR:directory}}).directory,directory);
});

test('bundled engine adopts legacy record location then works without the old project',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-engine-adopt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const project=path.join(root,'bgm-res'),legacy=path.join(root,'Bangumi_Auto_Rename'),data=path.join(root,'canonical','rename');await fs.mkdir(legacy,{recursive:true});await fs.mkdir(path.join(data,'task'),{recursive:true});await fs.writeFile(path.join(legacy,'.bgm-storage.json'),JSON.stringify({renameData:data}));
 const options={project,appData:root,env:{}};const adopted=resolveStorage(options);assert.equal(adopted.engine,path.join(project,'engine'));assert.equal(adopted.renameData,data);
 assert.deepEqual(resolveStorage({...options,env:{BGM_RENAME_PROJECT:adopted.engine}}),adopted);
 await fs.mkdir(adopted.engine,{recursive:true});await fs.writeFile(path.join(adopted.engine,'.bgm-storage.json'),JSON.stringify({renameData:data}));await fs.rename(legacy,path.join(root,'retired'));assert.deepEqual(resolveStorage(options),adopted);
});
