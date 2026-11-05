const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {prepare,dataPath}=require('../js/rename-integration.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bgm-unify-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const project=path.join(root,'engine'),directory=path.join(root,'manager');fs.mkdirSync(path.join(project,'data/task'),{recursive:true});fs.writeFileSync(path.join(project,'data/task/one.json'),'{"uuid":"one"}');return {project,directory};}
test('verified migration retains source and redirects subsequent reads without recopying',async t=>{const {project,directory}=fixture(t);const target=await prepare(directory,project,async()=>false);assert.equal(dataPath(directory,project),target);assert.equal(fs.readFileSync(path.join(target,'task/one.json'),'utf8'),'{"uuid":"one"}');assert.ok(fs.existsSync(path.join(project,'data/task/one.json')));fs.writeFileSync(path.join(target,'task/one.json'),'new');await prepare(directory,project,async()=>true);assert.equal(fs.readFileSync(path.join(target,'task/one.json'),'utf8'),'new');});
test('running legacy service prevents copy and pointer switch',async t=>{const {project,directory}=fixture(t);await assert.rejects(prepare(directory,project,async()=>true),/关闭/);assert.ok(!fs.existsSync(path.join(project,'.bgm-storage.json')));assert.ok(!fs.existsSync(path.join(directory,'rename')));});
test('preexisting destination and a missing bound directory are never silently replaced',async t=>{const {project,directory}=fixture(t);fs.mkdirSync(path.join(directory,'rename'),{recursive:true});await assert.rejects(prepare(directory,project,async()=>false),/已经存在/);fs.writeFileSync(path.join(project,'.bgm-storage.json'),JSON.stringify({renameData:path.join(directory,'rename')}));fs.rmdirSync(path.join(directory,'rename'));await assert.rejects(prepare(directory,project),/不可用/);});

test('migration media aliases stay references instead of copying video bytes',async t=>{const {project,directory}=fixture(t);const original=path.join(project,'data','alias.mkv');fs.writeFileSync(original,'media');const target=await prepare(directory,project,async()=>false);const alias=path.join(target,'alias.mkv');assert.ok(fs.lstatSync(alias).isSymbolicLink());assert.equal(fs.readlinkSync(alias),original);assert.equal(fs.readFileSync(alias,'utf8'),'media');assert.equal(fs.readFileSync(original,'utf8'),'media');});

test('bundled engine binds existing canonical records without copying or interrupting the service',async t=>{
 const {project,directory}=fixture(t);const target=path.join(directory,'rename');fs.mkdirSync(path.join(target,'task'),{recursive:true});fs.writeFileSync(path.join(target,'task','one.json'),'original');const previous=process.env.BGM_RENAME_DATA;process.env.BGM_RENAME_DATA=target;t.after(()=>{if(previous===undefined)delete process.env.BGM_RENAME_DATA;else process.env.BGM_RENAME_DATA=previous;});
 assert.equal(await prepare(directory,project,async()=>true),target);assert.equal(fs.readFileSync(path.join(target,'task','one.json'),'utf8'),'original');assert.equal(JSON.parse(fs.readFileSync(path.join(project,'.bgm-storage.json'),'utf8')).renameData,target);
});


test('legacy service on canonical data is diagnosed separately from foreign services',()=>{
 const {serviceConflict}=require('../js/rename-integration.cjs');
 const same=(a,b)=>Boolean(a&&b)&&a===b;
 assert.match(serviceConflict({service:'bangumi-rename',data_path:'data'},'data','engine',same),/同一数据目录的旧版/);
 assert.match(serviceConflict({service:'other',data_path:'data'},'data','engine',same),/其他服务/);
 assert.match(serviceConflict({service:'bangumi-rename',data_path:'foreign'},'data','engine',same),/其他数据目录/);
 assert.match(serviceConflict({service:'bangumi-rename',data_path:'data',engine_path:'old'},'data','engine',same),/其他源码目录/);
 assert.equal(serviceConflict({service:'bangumi-rename',data_path:'data',engine_path:'engine'},'data','engine',same),null);
});
