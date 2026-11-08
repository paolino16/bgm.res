const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const net=require('node:net');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function atomicJSON(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}
function sourceRoot(){return process.env.BGM_RENAME_PROJECT||path.resolve(__dirname,'../engine');}
function dataPath(directory,project=sourceRoot(),env=process.env){
  const pointer=path.join(project,'.bgm-storage.json');
  if(fs.existsSync(pointer))return JSON.parse(fs.readFileSync(pointer,'utf8')).renameData;
  return env.BGM_RENAME_DATA||path.join(project,'data');
}
function occupied(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(600);socket.on('connect',()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));socket.on('timeout',()=>{socket.destroy();resolve(false);});});}
function health(){return new Promise(resolve=>{const req=http.get('http://127.0.0.1:5999/integration/status',res=>{let text='';res.on('data',s=>text+=s);res.on('end',()=>{try{resolve(JSON.parse(text));}catch{resolve(null);}});});req.setTimeout(800,()=>req.destroy());req.on('error',()=>resolve(null));});}
async function prepare(directory,project=sourceRoot(),isOccupied=occupied){
  const target=path.join(directory,'rename');
  const pointer=path.join(project,'.bgm-storage.json');
  if(fs.existsSync(pointer)){
    const current=JSON.parse(fs.readFileSync(pointer,'utf8')).renameData;
    if(path.resolve(current)!==path.resolve(target))throw Error('整理引擎已绑定其他数据目录：'+current);
    if(!fs.existsSync(target))throw Error('统一数据目录不可用：'+target);
    return target;
  }
  const source=dataPath(directory,project);
  if(path.resolve(source).toLowerCase()===path.resolve(target).toLowerCase()&&fs.existsSync(path.join(target,'task'))){
    atomicJSON(pointer,{version:1,renameData:target});return target;
  }
  if(await isOccupied(5999))throw Error('首次整合前请关闭正在运行的整理服务（5999 端口），再点击资源整理。原记录尚未迁移。');
  if(fs.existsSync(target))throw Error('目标整理目录已经存在但尚未绑定，请先核对：'+target);
  fs.mkdirSync(directory,{recursive:true});
  const staging=target+'.staging-'+Date.now();
  // Copy all records, plans, configuration and journals; the old tree remains a backup.
  if(fs.existsSync(source))await fs.promises.cp(source,staging,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true,
    filter:async(src,dest)=>{
      // Migration aliases are references to media, not application records.
      const stat=await fs.promises.lstat(src);
      if(stat.isFile()&&/\.(mkv|mp4|avi|m2ts|ts|mov|wmv|webm|flv|mpg|mpeg|m4v)$/i.test(src)){
        await fs.promises.mkdir(path.dirname(dest),{recursive:true});
        await fs.promises.symlink(path.resolve(src),dest,'file');return false;
      }
      return true;
    }});else await fs.promises.mkdir(staging);
  async function verify(a,b){
    const crypto=require('node:crypto');
    const digest=file=>new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256');const stream=fs.createReadStream(file);stream.on('error',reject);stream.on('data',chunk=>hash.update(chunk));stream.on('end',()=>resolve(hash.digest('hex')));});
    for(const entry of await fs.promises.readdir(a,{withFileTypes:true})){
      const x=path.join(a,entry.name),y=path.join(b,entry.name);
      if(entry.isSymbolicLink()){
        if(await fs.promises.readlink(x)!==await fs.promises.readlink(y))throw Error('链接校验失败：'+x);
        continue;
      }
      if(!entry.isDirectory()&&(await fs.promises.lstat(y)).isSymbolicLink()&&await fs.promises.readlink(y)===path.resolve(x))continue;
      if(entry.isDirectory())await verify(x,y);
      else if(await digest(x)!==await digest(y))throw Error('复制校验失败：'+x);
    }
  }
  if(fs.existsSync(source))await verify(source,staging);
  fs.renameSync(staging,target);
  atomicJSON(pointer,{version:1,renameData:target,backupData:source});
  return target;
}
let signatureMemo;
function sourceSignature(project){
  if(signatureMemo?.project===project&&Date.now()-signatureMemo.time<2000)return signatureMemo.value;
  const root=path.join(project,'src'),files=[];
  function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory()&&entry.name!=='__pycache__')walk(file);else if(entry.isFile()&&entry.name.endsWith('.py'))files.push(file);}}
  walk(root);files.sort((a,b)=>{a=path.relative(root,a).replaceAll('\\','/');b=path.relative(root,b).replaceAll('\\','/');return a<b?-1:a>b?1:0;});
  const hash=require('node:crypto').createHash('sha256');for(const file of files){hash.update(path.relative(root,file).replaceAll('\\','/'));hash.update('\0');hash.update(fs.readFileSync(file));}
  const value=hash.digest('hex');signatureMemo={project,time:Date.now(),value};return value;
}
async function rawRequest(target,method,route,body){
  const {token}=JSON.parse(await fs.promises.readFile(path.join(target,'desktop-api.json'),'utf8'));
    return new Promise((resolve,reject)=>{
      const content=body===undefined?null:JSON.stringify(body);
      const req=http.request({hostname:'127.0.0.1',port:5999,path:'/integration/v1/'+route,method,
        headers:{'x-bgm-token':token,...(content?{'content-type':'application/json','content-length':Buffer.byteLength(content)}:{})}},res=>{
        const chunks=[];let bytes=0;res.on('data',chunk=>{bytes+=chunk.length;if(bytes>32*1024*1024){req.destroy(Error('整理响应过大'));return;}chunks.push(chunk);});
        res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200)reject(Error(data.detail||'整理服务请求失败'));else resolve(data);}catch(error){reject(error);}});
      });
      req.setTimeout(15000,()=>req.destroy(Error('整理服务响应超时，请稍后刷新')));req.on('error',reject);if(content)req.write(content);req.end();
    });
}
function serviceConflict(status,target,project,sameDirectory){
  if(status.service!=='bangumi-rename'||!sameDirectory(status.data_path,target))return '5999 端口由其他服务或其他数据目录占用，本次没有停止该服务';
  if(!status.engine_path)return '5999 端口运行的是使用同一数据目录的旧版整理服务，请退出旧整理服务后重试';
  if(!sameDirectory(status.engine_path,project))return '5999 端口运行的是其他源码目录的整理服务：'+status.engine_path+'。请退出该服务后重试';
  return null;
}
function create({directory,onReturn}){
  let pending,attachedPid;
  const outstanding=new Set();
  async function ensure(){
    const project=sourceRoot();
    if(!fs.existsSync(path.join(project,'src/desktop_service.py')))throw Error('找不到桌面整理后台：'+project);
    const target=await prepare(directory,project);
    const signature=sourceSignature(project);
    const sameDirectory=(a,b)=>{if(!a||!b)return false;if(path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase())return true;try{const x=fs.statSync(a,{bigint:true}),y=fs.statSync(b,{bigint:true});return x.ino!==0n&&x.ino===y.ino&&x.dev===y.dev;}catch{return false;}};
    let status=await health();
    if(status){
      const conflict=serviceConflict(status,target,project,sameDirectory);if(conflict)throw Error(conflict);
      if(status.api_version!==1)throw Error('整理后台接口版本不兼容');
      if(status.mode!=='desktop'||!(status.engine_revision>=5))throw Error('正在运行旧网页整理服务，请先退出旧服务后使用桌面后台');
      if((status.source_signature!==signature||status.draining)&&!outstanding.size&&!status.active_jobs){
        await rawRequest(target,'POST','control/shutdown',{});
        for(let i=0;i<100;i++){await delay(100);status=await health();if(!status)break;}
        if(status)throw Error('整理后台尚未退出，稍后会自动重试');
      }
    }
    if(!status){
      if(await occupied(5999))throw Error('5999 端口被其他服务占用');
      const windowless=path.join(project,'.venv/Scripts/pythonw.exe');
      const python=process.env.BGM_RENAME_PYTHON||(process.platform==='win32'&&fs.existsSync(windowless)?windowless:path.join(project,'.venv/Scripts/python.exe'));
      if(!fs.existsSync(python))throw Error('找不到 Python 环境：'+python);
      const log=fs.openSync(path.join(target,'integration-service.log'),'a');
      let child;
      try{
        const proxies=await require('./metadata-proxy.cjs').metadataProxies(url=>require('electron').session.defaultSession.resolveProxy(url));
        child=spawn(python,['-m','src.desktop_service'],{cwd:project,env:{...process.env,BGM_METADATA_PROXIES:JSON.stringify(proxies),BGM_RENAME_DATA:target,BGM_RENAME_HOST:'127.0.0.1'},windowsHide:true,detached:true,stdio:['ignore',log,log]});
      }finally{fs.closeSync(log);}
      let failure;child.on('error',e=>failure=e);child.unref();
      for(let i=0;i<100;i++){if(failure)throw failure;status=await health();if(status)break;await delay(300);}
      if(!status)throw Error('整理后台未就绪，请查看 integration-service.log');
      if(status.mode!=='desktop'||!sameDirectory(status.data_path,target)||!sameDirectory(status.engine_path,project))throw Error('整理后台身份校验失败');
    }
    if(attachedPid!==status.pid){
      await rawRequest(target,'POST','control/attach',{pid:Number(process.env.BGM_DESKTOP_OWNER_PID)||process.pid});
      attachedPid=status.pid;
    }
    return target;
  }
  async function ready(){if(!pending)pending=ensure().finally(()=>pending=null);return pending;}
  async function request(method,route,body){
    const target=await ready();
    const result=await rawRequest(target,method,route,body);
    if(result.job_id)outstanding.add(result.job_id);
    if(route.startsWith('jobs/')&&['completed','failed'].includes(result.state))outstanding.delete(result.id);
    return result;
  }

  return {ready,request,async action(action,body){return request('POST','action/'+encodeURIComponent(action),body||{});},onReturn};
}
module.exports={create,prepare,dataPath,sourceRoot,sourceSignature,serviceConflict};
