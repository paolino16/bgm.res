'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {sourceRoot}=require('./rename-integration.cjs');

function worker(args){
  const cwd=sourceRoot(),python=process.env.BGM_RENAME_PYTHON||path.join(cwd,'.venv/Scripts/python.exe');
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-X','utf8','-m','src.subtitle_sources'],{cwd,windowsHide:true});
    const chunks=[];let size=0,settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('字幕来源响应超时，请重试'));},120000);
    child.on('error',()=>finish(Error('无法启动字幕搜索引擎，请检查 Python 环境')));
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>12*1024*1024){child.kill();finish(Error('字幕来源返回的数据过大'));}else chunks.push(chunk);});
    child.on('close',code=>{try{if(code!==0)throw Error('字幕搜索引擎已退出，请检查依赖');const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(null,result);}catch(error){finish(error);}});
    child.stdin.end(JSON.stringify(args));
  });
}

function service({store,safeStorage,directory,inbox,run=worker,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const cache=new Map(),pending=new Map(),downloads=new Set();
  let token='',revision=0,queue=Promise.resolve(),lastRequest=-Infinity,rateUntil=0;
  const saved=store.get('subtitles.assrtToken');
  if(saved){try{token=safeStorage.decryptString(Buffer.from(saved,'base64'));}catch{/* Settings will request a replacement. */}}
  function settings(){return {configured:Boolean(token),persisted:Boolean(store.get('subtitles.assrtToken')),retryAt:rateUntil};}
  function configure(value){
    value=String(value||'').trim();
    if(value&&!/^[a-zA-Z0-9]{32}$/.test(value))throw Error('Token 应为 32 位字母或数字');
    if(value&&safeStorage.isEncryptionAvailable())store.set('subtitles.assrtToken',safeStorage.encryptString(value).toString('base64'));
    else store.delete('subtitles.assrtToken');
    token=value;revision++;cache.clear();return settings();
  }
  function validate(source){if(!Object.hasOwn(require('./subtitle-result-providers.cjs'),source))throw Error('不支持的字幕来源');}
  function page(value){if(value==null)return 1;if(!Number.isSafeInteger(value)||value<1||value>10000)throw Error('无效的分页');return value;}
  function id(value){if(!/^[1-9]\d{0,11}$/.test(String(value)))throw Error('无效的字幕编号');return String(value);}
  function unwrap(result){if(result.error)throw Error(result.error);return result.value;}
  async function invoke(args){
    if(args.source!=='assrt')return unwrap(await run(args));
    if(!token)throw Error('请先配置射手网 API Token');
    const version=revision,credential=token;
    const task=queue.then(async()=>{
      if(version!==revision)throw Error('Token 已变更，请重新操作');
      if(rateUntil>now())return {waiting:true,retryAt:rateUntil};
      await sleep(Math.max(0,lastRequest+3500-now()));
      if(version!==revision)throw Error('Token 已变更，请重新操作');
      lastRequest=now();
      const result=await run({...args,token:credential});
      if(version!==revision)throw Error('Token 已变更，请重新操作');
      if(result.code==='rate_limit'){
        rateUntil=now()+Math.min(3600,Math.max(1,result.retryAfter||60))*1000;
        return {waiting:true,retryAt:rateUntil};
      }
      return unwrap(result);
    });
    queue=task.catch(()=>{});return task;
  }
  function cached(args){
    const key=JSON.stringify([revision,args]),hit=cache.get(key);
    if(hit&&now()-hit.time<300000)return Promise.resolve(hit.value);
    if(pending.has(key))return pending.get(key);
    const version=revision;
    const task=invoke(args).then(value=>{
      if(!value.waiting&&version===revision){cache.set(key,{time:now(),value});if(cache.size>160)cache.delete(cache.keys().next().value);}
      return value;
    }).finally(()=>pending.delete(key));pending.set(key,task);return task;
  }
  async function search({source,query,cursor}){
    validate(source);query=String(query||'').trim().slice(0,100);
    if(!query)throw Error('请输入作品名');
    return cached({action:'search',source,query,cursor:page(cursor)});
  }
  const entries=new Map(),downloadPending=new Map();
  async function detail({source,id:entryId,cursor}){
    validate(source);entryId=id(entryId);cursor=page(cursor);
    const result=await cached({action:'detail',source,id:entryId,cursor});
    if(!result.waiting){
      for(const post of result.posts)for(const file of post.files){
        const key=JSON.stringify([source,entryId,post.id,file.id]);
        entries.set(key,{file,cursor});
      }
      if(entries.size>10000){for(const key of [...entries.keys()].slice(0,entries.size-10000))entries.delete(key);}
    }
    return result;
  }
  function download({source,id:entryId,postId,fileId,workId,workName}){
    validate(source);entryId=id(entryId);postId=id(postId);
    const key=JSON.stringify([source,entryId,postId,String(fileId)]),entry=entries.get(key);
    if(!entry)throw Error('请先展开字幕详情，再选择附件');
    if(downloadPending.has(key))return downloadPending.get(key);
    const task=invoke({action:'download',source,file:entry.file,page:entry.cursor,directory}).then(value=>{
      if(!value.waiting){downloads.add(path.resolve(value.folder));inbox?.record(value,{source,workId,workName});}
      return value;
    }).finally(()=>downloadPending.delete(key));downloadPending.set(key,task);return task;
  }
  function folder(value){
    if(inbox)return inbox.folder(value);
    const target=path.resolve(String(value||''));
    if(!downloads.has(target)||!fs.existsSync(target))throw Error('下载目录不存在，请重新下载');
    return target;
  }
  async function local({archive,workId,workName}){
    if(!path.isAbsolute(String(archive||''))||!['.zip','.7z','.rar'].includes(path.extname(archive).toLowerCase()))throw Error('请选择 ZIP、7Z 或 RAR 字幕压缩包');
    const value=await invoke({action:'extract-local',source:'local',archive,directory});
    downloads.add(path.resolve(value.folder));inbox?.record(value,{source:'local',workId,workName});return value;
  }
  return {settings,configure,search,detail,download,folder,local};
}

function register({ipcMain,app,sysdata}){
  const {safeStorage,shell}=require('electron');
  const directory=path.join(app.getPath('userData'),'subtitle-downloads');
  const inbox=require('./subtitle-inbox.cjs').create(directory);require('./subtitle-inbox.cjs').setActive(inbox);
  const client=service({store:sysdata,safeStorage,directory,inbox});
  ipcMain.handle('subtitle-inbox:list',()=>{inbox.reconcile(path.join(require('./rename-integration.cjs').dataPath(app.getPath('userData')),'subtitle_operations'));return inbox.list();});
  ipcMain.handle('subtitle-inbox:command',async(event,args)=>{
    if(args.command==='discard'){
      const item=inbox.list().find(item=>item.id===args.id);if(!item)throw Error('下载包不存在');
      const {dialog,BrowserWindow}=require('electron');
      const result=await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender),{type:'warning',buttons:['取消','放弃并清理'],defaultId:0,cancelId:0,message:'放弃剩余字幕并清理下载包？',detail:item.name+'\n将删除原包、解压文件和其他附件；已导入字幕保持可用。'});
      if(result.response!==1)return {cancelled:true};
    }
    return inbox.command(args);
  });
  ipcMain.handle('subtitle-sources:settings',()=>client.settings());
  ipcMain.handle('subtitle-sources:configure',(_,token)=>client.configure(token));
  for(const action of ['search','detail','download'])ipcMain.handle('subtitle-sources:'+action,(_,args)=>client[action](args));
  ipcMain.handle('subtitle-sources:local',(_,args)=>client.local(args));
  ipcMain.handle('subtitle-sources:folder',async(_,folder)=>{const error=await shell.openPath(client.folder(folder));if(error)throw Error(error);});
  ipcMain.handle('subtitle-sources:open',(_,value)=>{
    const url=new URL(String(value));
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('无效的网页链接');
    return shell.openExternal(url.href);
  });
  return client;
}
module.exports={service,worker,register};
