'use strict';
const path = require('node:path');

const fs = require('node:fs');
const defaultAddress = 'http://127.0.0.1:8080';
const finished = new Set(['uploading','stalledUP','forcedUP','queuedUP','pausedUP','stoppedUP']);
const active = row => ['waiting','unconfirmed','downloading','missing','complete'].includes(row.stage);
const confirmationTimeout = 60000;

function localAddress() {
  try {
    const ini=fs.readFileSync(path.join(process.env.APPDATA,'qBittorrent','qBittorrent.ini'),'utf8');
    const port=Number(/^WebUI\\Port=(\d+)\s*$/mi.exec(ini)?.[1]);
    const https=/^WebUI\\HTTPS\\Enabled=true\s*$/mi.test(ini);
    if (port>0 && port<=65535) return (https?'https':'http')+'://127.0.0.1:'+port;
  } catch { /* Use qBittorrent's standard port on a fresh installation. */ }
  return defaultAddress;
}

function address(value) {
  const url = new URL(value || defaultAddress);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost','127.0.0.1','[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('请填写本机 Web UI 地址，例如 '+defaultAddress);
  return url.origin;
}

class QbitClient {
  constructor(config, password) {
    this.origin = address(config.url);
    this.username = config.username;
    this.password = password;
  }

  async request(route, options = {}) {
    try {
      return await fetch(this.origin+'/api/v2/'+route, {
        ...options, redirect:'error', signal:AbortSignal.timeout(6000),
        headers:{Referer:this.origin+'/', ...(this.cookie && {Cookie:this.cookie})}
      });
    } catch { throw Error('连接不到 qBittorrent，请检查 Web UI 地址和端口'); }
  }

  async get(route, options) {
    if (this.authError) throw Error(this.authError);
    let response = await this.request(route, options);
    if (response.status === 403 && this.username) {
      const login = await this.request('auth/login',{method:'POST',
        body:new URLSearchParams({username:this.username,password:this.password()})});
      if (!login.ok || (await login.text()).trim() !== 'Ok.') {
        this.authError = 'qBittorrent 登录失败，请检查凭据并重新保存设置';
        throw Error(this.authError);
      }
      this.cookie = login.headers.get('set-cookie')?.split(';')[0];
      response = await this.request(route, options);
    }
    if (!response.ok) throw Error(response.status===403 ? 'qBittorrent 拒绝访问，请配置 Web UI 凭据' : 'qBittorrent 返回 HTTP '+response.status);
    return response;
  }
}

function selectedFiles(info, entries) {
  if (!path.isAbsolute(info.save_path)) throw Error('qBittorrent 未返回本机保存路径');
  const selected = entries.filter(entry=>entry.priority>0);
  if (!selected.length) throw Error('种子没有勾选文件');
  if (selected.some(entry=>entry.progress!==1)) return null;
  return selected.map(entry=>{
    const file = path.resolve(info.save_path,entry.name);
    const relative = path.relative(info.save_path,file);
    if (!relative || relative.split(path.sep)[0]==='..' || path.isAbsolute(relative) || path.isAbsolute(entry.name))
      throw Error('种子文件路径超出保存目录');
    return file;
  });
}

class DownloadMonitor {
  constructor(store, organizer, safeStorage) {
    this.store = store;
    this.organizer = organizer;
    this.safeStorage = safeStorage;
    const saved = store.get('resources.downloads',[]);
    this.rows = Array.isArray(saved) ? saved : [];
    this.live = new Map();
    this.library = new Map();
    this.config = {url:localAddress(),...store.get('resources.webui',{})};
    this.connectionError = '';
  }
  preferences() {
    return {url:this.config.url || defaultAddress,username:this.config.username || '',
      hasPassword:Boolean(this.config.secret),automatic:this.config.automatic!==false};
  }
  configuration(input) {
    const config = {url:address(input.url),username:input.username.trim(),automatic:Boolean(input.automatic)};
    if (input.password) config.secret = this.safeStorage.encryptString(input.password).toString('base64');
    else if (config.username && this.config.username===config.username && this.config.secret) config.secret=this.config.secret;
    return config;
  }
  client(config) {
    return new QbitClient(config,()=>config.secret ? this.safeStorage.decryptString(Buffer.from(config.secret,'base64')) : '');
  }
  async configure(input, test) {
    const config = this.configuration(input);
    if (test) {
      const response = await this.client(config).get('app/version');
      if (!/^v?\d+\.\d+/.test(await response.text())) throw Error('该地址未返回 qBittorrent 版本');
      return;
    }
    this.store.set('resources.webui',config);
    this.config=config;
    this.api=null;
    this.connectionError='';
    void this.poll();
  }
  save(){ this.store.set('resources.downloads',this.rows); }
  track(hash,title) {
    hash=hash.toLowerCase();
    if (!this.rows.some(row=>row.hash===hash)) {
      this.rows.unshift({hash,title,stage:'waiting',requestedAt:Date.now()});
      this.save();
    } else {
      const row=this.rows.find(row=>row.hash===hash);
      if (row.stage==='unconfirmed') this.change(row,'waiting',{requestedAt:Date.now()});
    }
    void this.poll();
  }
  change(row,stage,extra={}) {
    if (!this.rows.includes(row)) return;
    if (stage==='recognizing') this.library.delete(row.hash);
    Object.assign(row,{stage},extra);
    this.save();
  }
  command(hash,command) {
    if (command==='clear-unconfirmed') {
      this.rows=this.rows.filter(row=>row.stage!=='unconfirmed');
      this.save();
      return;
    }
    const row=this.rows.find(row=>row.hash===hash);
    if (!row || row.stage==='recognizing') return;
    if (command==='remove') {
      this.rows.splice(this.rows.indexOf(row),1);
      this.live.delete(hash);
      this.library.delete(hash);
      this.save();
    } else if (command==='retry' && ['failed','complete'].includes(row.stage)) {
      this.change(row,row.files?.length?'recognizing':'complete',{manual:true,error:''});
      void this.poll();
    }
  }
  snapshot() {
    return {error:this.connectionError,rows:this.rows.map(({files,...row})=>({...row,...this.live.get(row.hash),...this.library.get(row.hash)}))};
  }
  async syncLibrary() {
    const rows=this.rows.filter(row=>row.taskId && ['ready','failed'].includes(row.stage));
    if (!rows.length) return;
    try {
      const data=await this.organizer.request('GET','tasks?summary=true');
      if (!Array.isArray(data.tasks)) throw Error('整理后台未返回任务状态');
      const tasks=new Map(data.tasks.map(task=>[task.uuid,task]));
      for (const row of rows) {
        if (!this.rows.includes(row)) continue;
        const task=tasks.get(row.taskId);
        const status=!task?(data.errors?.length?'unknown':'missing'):
          task.review_state==='cancelled'||task.plan_state==='cancelled'?'cancelled':
          task.error?'failed':task.plan_state==='pending'?'pending':
          task.plan_state==='completed'?'imported':'unknown';
        this.library.set(row.hash,{libraryStatus:status,libraryError:task?.error||''});
      }
    } catch (error) {
      for (const row of rows) if (this.rows.includes(row))
        this.library.set(row.hash,{libraryStatus:'unknown',libraryError:'入库状态暂时无法确认：'+error.message});
    }
  }
  async advanceJob(row) {
    try {
      // The engine derives a stable task UUID from the torrent hash. Resubmitting
      // after a lost response or expired job recovers the original review plan.
      if (!row.job) {
        const {job_id}=await this.organizer.action('recognize-torrent',{
          torrent:row.hash,path:row.root,files:row.files,title:row.sourceTitle,retry:!!row.manual
        });
        this.change(row,'recognizing',{job:job_id});
        return;
      }
      const job=await this.organizer.request('GET','jobs/'+row.job);
      if (job.state==='failed') throw Error(job.error || '识别失败');
      if (job.state==='completed') {
        if (!job.result?.task_id) throw Error(job.result?.message || '没有生成识别方案');
        this.change(row,job.result.error?'failed':'ready',{taskId:job.result.task_id,
          error:job.result.error || '',job:null,manual:false,files:job.result.error?row.files:null});
      }
    } catch (error) {
      if (error.message.includes('任务状态已失效')) this.change(row,'recognizing',{job:null});
      else this.change(row,'failed',{error:error.message,job:null});
    }
  }
  async poll() {
    if (this.busy || this.stopped) return;
    this.busy=true;
    try {
      for (const row of this.rows.filter(row=>row.stage==='recognizing')) await this.advanceJob(row);
      await this.syncLibrary();
      const watched=this.rows.filter(active);
      if (!watched.length) { this.connectionError=''; return; }
      const api=this.api ||= this.client(this.config);
      for (let i=0;i<watched.length;i+=64) {
        const batch=watched.slice(i,i+64);
        const result=await api.get('torrents/info?hashes='+batch.map(row=>row.hash).join('%7C'));
        const torrents=new Map((await result.json()).map(info=>[info.hash.toLowerCase(),info]));
        if (api!==this.api || this.stopped) return;
        this.connectionError='';
        for (const row of batch) {
          if (!this.rows.includes(row)) continue;
          const info=torrents.get(row.hash);
          if (!info) {
            this.live.delete(row.hash);
            if (row.stage==='waiting') {
              // Start a grace period for records saved before timestamps existed.
              if (!row.requestedAt) { row.requestedAt=Date.now(); this.save(); }
              if (Date.now()-row.requestedAt>=confirmationTimeout) this.change(row,'unconfirmed');
            } else if (!['unconfirmed','missing'].includes(row.stage)) this.change(row,'missing');
            continue;
          }
          this.live.set(row.hash,{progress:info.progress,speed:info.dlspeed,state:info.state,eta:info.eta});
          const complete=finished.has(info.state) && info.progress===1 && info.amount_left===0;
          const stage=complete?'complete':'downloading';
          if (row.stage!==stage) this.change(row,stage);
          if (!complete || (!row.manual && this.config.automatic===false)) continue;
          try {
            const files=selectedFiles(info,await (await api.get('torrents/files?hash='+row.hash)).json());
            if (files && this.rows.includes(row) && !this.stopped && api===this.api)
              this.change(row,'recognizing',{files,root:info.save_path,sourceTitle:info.name,job:null});
          } catch(error) { this.change(row,'failed',{error:error.message}); }
        }
      }
    } catch(error) { this.connectionError=error.message; }
    finally { this.busy=false; }
  }
  start() {
    this.timer=setInterval(()=>this.poll(),4000);
    this.timer.unref();
    void this.poll();
  }
  stop(){this.stopped=true;clearInterval(this.timer);}
}
module.exports={DownloadMonitor,QbitClient,selectedFiles};
