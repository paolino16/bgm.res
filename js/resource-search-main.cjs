'use strict';
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {sourceRoot} = require('./rename-integration.cjs');

const sources = ['dmhy', 'mikan', 'anibt', 'nyaa', 'knaben', 'ext'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function worker(args) {
  const cwd = sourceRoot();
  const python = process.env.BGM_RENAME_PYTHON || path.join(cwd, '.venv/Scripts/python.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-X', 'utf8', '-m', 'src.resource_search'], {cwd, windowsHide:true});
    const output = [], errors = [];
    child.on('error', reject);
    child.stdout.on('data', part => output.push(part));
    child.stderr.on('data', part => errors.push(part));
    child.stdin.on('error', reject);
    child.on('close', code => {
      try {
        if (code !== 0) throw Error(Buffer.concat(errors).toString().slice(-500) || '资源搜索进程已退出');
        const {value,error} = JSON.parse(Buffer.concat(output).toString());
        if (error) throw Error(error);
        resolve(value);
      } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify(args));
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

class ExtSession {
  generation = 0;
  queue = Promise.resolve();
  resolved = new Map();
  resolving = new Map();

  start() {
    if (!this.ready) {
      const version = this.generation;
      this.ready = this.launch(version).catch(error => {
        if (this.generation === version) this.stop();
        throw error;
      });
    }
    return this.ready;
  }
  async launch(version) {
    const exe = await worker({action:'setup'});
    const port = await freePort();
    if (version !== this.generation) throw Error('EXT 已关闭');
    const proc = spawn(exe, [], {cwd:path.dirname(exe), windowsHide:true, stdio:'ignore',
      // FlareSolverr 3.5.2 recognises the English Cloudflare challenge titles.
      env:{...process.env, LANG:'en-US', HOST:'127.0.0.1', PORT:String(port)}});
    this.process = proc;
    let failure;
    proc.once('error', error => { failure = error; });
    proc.once('exit', () => { if (this.process === proc) this.stop(); });
    for (let i=0; i<120; i++) {
      if (version !== this.generation || failure) throw failure || Error('EXT 进程已停止');
      try {
        await new Promise((resolve,reject) => {
          const socket = net.connect(port,'127.0.0.1', () => {socket.end(); resolve();});
          socket.on('error',reject);
        });
        await worker({action:'warm', source:'ext', port});
        return port;
      } catch (error) { if (error.code !== 'ECONNREFUSED') throw error; }
      await delay(500);
    }
    throw Error('EXT 启动超时，请重试');
  }
  run(args) {
    const version = this.generation;
    const task = this.queue.then(async () => {
      if (this.generation !== version) throw Error('EXT 已关闭，请重试');
      return worker({...args, port:await this.start()});
    });
    this.queue = task.catch(() => {});
    return task;
  }
  resolve(row) {
    const key = row.page;
    if (this.resolved.has(key)) return Promise.resolve(this.resolved.get(key));
    if (!this.resolving.has(key)) {
      const version = this.generation;
      const task = this.run({action:'resolve',source:'ext',row}).then(value => {
        if (version !== this.generation) throw Error('EXT 已关闭，请重试');
        this.resolved.set(key,value);
        if (this.resolved.size>512) this.resolved.delete(this.resolved.keys().next().value);
        return value;
      }).finally(()=>this.resolving.delete(key));
      this.resolving.set(key,task);
    }
    return this.resolving.get(key);
  }
  stop() {
    this.generation++;
    const proc = this.process;
    this.ready = null;
    this.process = null;
    if (proc?.pid && proc.exitCode === null) execFile('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true},()=>{});
  }
}

async function findQbit(store) {
  const saved = store.get('resources.qbit');
  const defaults = [saved, ...['ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA'].filter(k=>process.env[k])
    .map(k=>path.join(process.env[k],'qBittorrent','qbittorrent.exe'))];
  for (const exe of defaults) if (exe && fs.existsSync(exe)) return exe;
  for (const key of ['HKCR\\qBittorrent.File\\shell\\open\\command','HKCR\\Applications\\qbittorrent.exe\\shell\\open\\command','HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\qbittorrent.exe']) {
    try {
      const {stdout} = await promisify(execFile)('reg.exe',['query',key,'/ve'],{windowsHide:true});
      const exe = stdout.match(/REG_SZ\s+"?([^"\r\n]*?qbittorrent\.exe)/i)?.[1];
      if (exe && fs.existsSync(exe)) return exe;
    } catch {}
  }
  for (const hive of ['HKLM','HKCU']) {
    for (const view of ['32','64']) {
      try {
        const key=hive+'\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qBittorrent';
        const {stdout}=await promisify(execFile)('reg.exe',['query',key,'/v','DisplayIcon','/reg:'+view],{windowsHide:true});
        const exe=stdout.match(/REG_SZ\s+"?([^"\r\n]*?qbittorrent\.exe)/i)?.[1];
        if(exe && fs.existsSync(exe))return exe;
      } catch {}
    }
  }
  return '';
}

function register({ipcMain,app,sysdata,organizer}) {
  const {dialog,clipboard,safeStorage} = require('electron');
  const {SeaDexClient,requestJSON}=require('./seadex.cjs');
  const seadex=new SeaDexClient({fetchJSON:url=>requestJSON(require('electron').net,url)});
  ipcMain.handle('resources:seadex',(_,hashes)=>seadex.lookup(hashes));
  const {DownloadMonitor} = require('./qbit-monitor.cjs');
  const monitor = new DownloadMonitor(sysdata,organizer,safeStorage);
  monitor.start();
  app.once('before-quit',()=>monitor.stop());
  ipcMain.handle('downloads:list',()=>monitor.snapshot());
  ipcMain.handle('downloads:command',(_,{hash,command})=>monitor.command(hash,command));
  ipcMain.handle('downloads:configure',(_,{input,test})=>monitor.configure(input,test));
  const ext = new ExtSession(), cache = new Map(), pending = new Map();
  const folder = path.join(app.getPath('home'),'Downloads','Torrents');
  const enabled = () => sysdata.get('resources.ext', false);
  const warm = () => ext.start().catch(e => console.warn('EXT:',e.message));
  function cached(args) {
    const key = JSON.stringify(args);
    const saved = cache.get(key);
    if (saved && Date.now()-saved.time<180000) return Promise.resolve(saved.rows);
    if (!pending.has(key)) {
      const task = args.source === 'ext' ? ext.run(args) : worker(args);
      pending.set(key,task.then(rows=>{
        cache.set(key,{time:Date.now(),rows});
        if (cache.size>60) cache.delete(cache.keys().next().value);
        return rows;
      }).finally(()=>pending.delete(key)));
    }
    return pending.get(key);
  }
  if (enabled()) warm();
  app.once('before-quit',()=>ext.stop());
  ipcMain.handle('resources:settings',()=>({enabled:enabled(), folder, webui:monitor.preferences()}));
  ipcMain.handle('resources:enable',(_,value)=>{
    sysdata.set('resources.ext', Boolean(value));
    if (value) warm(); else ext.stop();
  });
  ipcMain.handle('resources:romaji',(_,name)=>worker({action:'romaji',name:String(name).slice(0,300)}));
  ipcMain.handle('resources:search',async (_, {source,query,cursor=null})=>{
    query = String(query).trim().slice(0,300);
    if (!query || !sources.includes(source)) throw Error('请输入关键词并选择来源');
    if (source === 'ext' && !enabled()) throw Error('EXT 已关闭');
    if (source === 'mikan' && cursor != null) {
      if (!Number.isInteger(cursor) || cursor<1) throw Error('无效的蜜柑分页');
      const {rows} = await cached({action:'mikan-web',source,query});
      const end = cursor*100;
      return {rows:rows.slice(end-100,end),next:end<rows.length?cursor+1:null};
    }
    return cached({action:'search',source,query,cursor});
  });
  ipcMain.handle('resources:files',async (_, {row,magnetOnly=false})=>{
    if (!sources.includes(row.source)) throw Error('无效的资源来源');
    let hash=row.hash || '', magnet=row.magnet;
    if (row.source==='ext' && !hash) {
      if (!enabled()) throw Error('请先启用 EXT');
      ({hash,magnet}=await ext.resolve(row));
    }
    if (hash && !/^[a-f0-9]{40}$/i.test(hash)) throw Error('无效的种子哈希');
    const nyaaId=row.source==='nyaa' && /^https:\/\/nyaa\.si\/view\/(\d+)$/.exec(row.page)?.[1];
    const attachment=row.torrent || (nyaaId && 'https://nyaa.si/download/'+nyaaId+'.torrent');
    let source;
    if (attachment && !magnetOnly) {
      if (!['mikan','nyaa','anibt','dmhy'].includes(row.source)) throw Error('无效的种子来源');
      return cached({action:'files',source:row.source,row:{source:row.source,torrent:attachment,hash}});
    } else if (hash) {
      const params=new URLSearchParams({xt:'urn:btih:'+hash});
      if (magnet?.startsWith('magnet:?')) {
        for (const tracker of new URL(magnet).searchParams.getAll('tr')) params.append('tr',tracker);
      }
      source='magnet:?'+params;
    } else throw Error('此来源没有可用于预览的种子或磁链');

    const api=monitor.api ||= monitor.client(monitor.config);
    const response=await api.get('torrents/fetchMetadata',{
      method:'POST',body:new URLSearchParams({source:encodeURIComponent(source)})
    });
    if (response.status===202) return {pending:true};
    const metadata=await response.json();
    if (hash && metadata.infohash_v1?.toLowerCase()!==hash.toLowerCase())
      throw Error('种子哈希与搜索结果不符');
    const files=metadata.info?.files;
    if (!Array.isArray(files) || !files.length) throw Error('种子未返回文件清单');
    return {files:files.map(file=>({path:file.path,size:file.length})),size:metadata.info.length};
  });
  ipcMain.handle('resources:action',async (_, {row,action})=>{
    if (!['copy','open'].includes(action) || !sources.includes(row.source)) throw Error('无效的资源操作');
    const args = {action:'resolve',source:row.source,row,saveDir:action==='open'?folder:null};
    let result;
    if (row.source === 'ext' && !row.hash) {
      if (!enabled()) throw Error('请先启用 EXT');
      result = await ext.resolve(row);
    } else {
      result = await worker({...args,source:row.source==='ext'?'resolved':row.source});
    }
    if (action === 'copy') clipboard.writeText(result.magnet);
    else {
      let exe = await findQbit(sysdata);
      if (!exe) {
        const choice = await dialog.showOpenDialog({title:'选择 qBittorrent 程序',properties:['openFile'],filters:[{name:'qBittorrent',extensions:['exe']}]});
        if (choice.canceled) return {...result,cancelled:true};
        exe = choice.filePaths[0];
        if (path.basename(exe).toLowerCase()!=='qbittorrent.exe') throw Error('请选择 qbittorrent.exe');
        sysdata.set('resources.qbit',exe);
      }
      await new Promise((resolve,reject)=>{
        const child = spawn(exe,[result.file || result.magnet],{detached:true,stdio:'ignore',windowsHide:false});
        child.once('error',reject);
        child.once('spawn',()=>{child.unref(); resolve();});
      });
      monitor.track(result.hash,row.title);
    }
    return result;
  });
}
module.exports = {register,ExtSession,worker,findQbit};
