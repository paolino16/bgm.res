const fs=require('fs');const path=require('path');
const core=require('./rename-binding-core.cjs');
async function start({ipcMain,app,sysdata,snapshotStore,Datastore}){
  const directory=process.env.BGM_RES_DATA_DIR||path.join(app.getPath('appData'),'bgm.res');fs.mkdirSync(directory,{recursive:true});
  const filename=path.join(directory,'MediaData.db');
  if(fs.existsSync(filename))fs.copyFileSync(filename,filename+'.startup-backup');
  const db=new Datastore({filename,autoload:false});await new Promise((r,j)=>db.loadDatabase(e=>e?j(e):r()));
  const docs=await new Promise((r,j)=>db.find({},(e,d)=>e?j(e):r(d)));const data=Object.fromEntries(docs.map(d=>[d._id,d.data]));
  const save=(k,v)=>new Promise((r,j)=>db.update({_id:k},{$set:{data:coreClone(v)}},{upsert:true},e=>e?j(e):r()));
  for(const [key,work]of Object.entries(data)){
    if(!work?.Cover)continue;
    const cover=require('./cover-path.cjs').resolveCover(work.Cover,directory);
    if(cover!==work.Cover){work.Cover=cover;delete work.DisplayCover;await save(key,work);}
  }
  const {BangumiNetwork}=require('./bangumi-network.cjs');
  const network=new BangumiNetwork({net:require('electron').net,directory});
  require('./discovery.cjs').register({ipcMain,network,sysdata,snapshotStore,safeStorage:require('electron').safeStorage});
  const thumbnails=new (require('./cover-thumbnails.cjs').CoverThumbnails)({directory,nativeImage:require('electron').nativeImage});
  const metadataRefreshes=new Map();
  ipcMain.handle('bangumi:request',async(event,options)=>{
    try{
      const result=await network.request(options);
      if(result.stale&&options.preferCached){
        const url=options.url;
        if(!metadataRefreshes.has(url)){
          const refresh=network.request({...options,preferCached:false}).finally(()=>metadataRefreshes.delete(url));
          metadataRefreshes.set(url,refresh);
        }
        metadataRefreshes.get(url).then(fresh=>{
          if(fresh.status===200&&!fresh.stale&&!event.sender.isDestroyed())event.sender.send('bangumi:updated',{url,body:fresh.body});
        }).catch(()=>{});
      }
      return result;
    }catch(error){return {error:error.message};}
  });
  const integration=require('./rename-integration.cjs');
  let report={works:0,errors:[]};
  async function importBindings({taskId,checkSubtitles=false}={}){
    const nextReport={works:0,errors:[],checked:0,removed:0};
    const subtitleFiles=new Set();
    const dataDir=fs.existsSync(path.join(directory,'rename')) ? path.join(directory,'rename') : process.env.BGM_RENAME_DATA;
    if(dataDir){
      const parsed=await core.readRename(dataDir);nextReport.errors=parsed.errors;
      let max=Math.max(0,...Object.keys(data).filter(k=>/^WorkSaveNo\d+$/.test(k)).map(k=>Number(k.slice(10))));
      for(const raw of parsed.groups){
        let key=Object.keys(data).find(k=>/^WorkSaveNo\d+$/.test(k)&&String(data[k].bgmID)===raw.id);
        if(!require('./task-library-cleanup.cjs').needsTaskRefresh(raw,data[key],taskId))continue;
        if(!key)key='WorkSaveNo'+(++max);
        const group=await require('./file-health.cjs').inspect(raw,data[key]);
        const previous=data[key];
        const merged=core.mergeWork(group,previous,key);
        const oldIgnored=new Set((previous?.RenameBinding?.ignoredMissing||[]).map(core.normalized));
        nextReport.checked+=group.files.length;
        nextReport.removed+=merged.RenameBinding.ignoredMissing.filter(file=>!oldIgnored.has(core.normalized(file))).length;
        if(data.LastWatched)data.LastWatched=core.remapRecent(data.LastWatched,previous,merged);
        if(JSON.stringify(previous)!==JSON.stringify(merged)){await save(key,merged);data[key]=merged;}
        if(checkSubtitles)for(const file of require('./subtitle-index.cjs').filesOf(merged))subtitleFiles.add(file);
        nextReport.works++;
      }
      if(data.LastWatched)await save('LastWatched',data.LastWatched);
      if(subtitleFiles.size)try{await subtitles.scanFiles([...subtitleFiles]);}catch(error){
        nextReport.warning='作品已导入，但字幕状态更新失败：'+error.message;
      }
      fs.writeFileSync(path.join(directory,'rename-import-report.json'),JSON.stringify(nextReport,null,2));
    }
    const works=Object.values(data).filter(work=>work?.WorkSaveNo);
    sysdata.set('Settings.checkboxC.LocalStorageMediaBaseNumber',works.length);
    sysdata.set('Settings.checkboxC.LocalStorageMediaBaseDeleteNumber',works.filter(work=>work.ExistCondition==='Deleted').length);
    report=nextReport;return nextReport;
  }
  await importBindings();
  // One NeDB owner for all windows. UI aliases may be sorted; persisted IDs never change.
  ipcMain.on('library:snapshot',event=>{event.returnValue=core.projection(data);});
  await thumbnails.prepare(data);
  const subtitles=new (require('./subtitle-index.cjs').SubtitleIndex)({directory,onProgress:progress=>{
    for(const window of require('electron').BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('subtitles:progress',progress);
  }});
  await subtitles.load();
  const {probeMedia,findProbe}=require('./subtitle-index.cjs');
  const durations=new (require('./media-duration.cjs').DurationIndex)({directory,probeFile:probeMedia,resolveTool:findProbe,sharedIndex:subtitles.index});await durations.load();
  ipcMain.handle('media:duration',(_event,{id,path:target})=>{const work=getWork(id);const files=[...require('./subtitle-index.cjs').filesOf(work),...[...(work.RenameBinding?.files||[]),...(work.RenameBinding?.resources||[])].map(file=>file.path),...Object.values(work.SPDetails||{}).flatMap(slot=>(slot.Versions||[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))}]).map(file=>file.path))].filter(Boolean);if(!files.some(file=>core.normalized(file)===core.normalized(target)))throw Error('只能读取已登记的视频');return durations.get(target);});
  const decorate=()=>subtitles.decorate(thumbnails.decorate(coreClone(data)));
  const getWork=id=>{if(!/^WorkSaveNo\d+$/.test(id)||!data[id])throw Error('番剧不存在');return data[id];};
  require('./cadensview-main.cjs').register({ipcMain,app,sysdata,getWork});
  ipcMain.handle('library:read',decorate);
  ipcMain.handle('library:play',async(_event,{id,path:target})=>{
    const work=getWork(id);
    const registered=[...(work.RenameBinding?.files||[]),...(work.RenameBinding?.resources||[]),...['EPDetails','SPDetails'].flatMap(kind=>Object.values(work[kind]||{}).flatMap(slot=>[{path:slot.AbsolutePath||(slot.URL&&path.resolve(work.URL,slot.URL))},...(slot.Versions||[])]))];
    if(typeof target!=='string'||!path.isAbsolute(target)||!registered.some(file=>file.path&&core.normalized(file.path)===core.normalized(target)))throw Error('只能播放当前作品已登记的文件');
    return require('./episode-playlist.cjs').play({work,file:target,directory,shell:require('electron').shell});
  });
  ipcMain.handle('library:explorer',async(_event,{id,path:target,reveal=false,original=false})=>{
    const work=getWork(id);
    const registered=[work.URL,...(work.RenameBinding?.files||[]).map(file=>file.path),...['EPDetails','SPDetails'].flatMap(kind=>Object.values(work[kind]||{}).flatMap(slot=>[slot.AbsolutePath,...(slot.Versions||[]).map(v=>v.path)]))].filter(Boolean);
    if(!path.isAbsolute(target)||!registered.some(file=>core.normalized(file)===core.normalized(target)))throw Error('只能打开当前作品已登记的文件位置');
    if(original){
      const source=require('./desktop-actions.cjs').sourcePath(work,target);
      if(!source)throw Error('没有记录这个文件的原始来源路径');
      const folder=path.dirname(source);
      try{await fs.promises.access(folder);}catch{throw Error('原视频文件夹不存在或当前不可访问：'+folder);}
      await require('./explorer-window.cjs').openExplorer({file:folder,shell:require('electron').shell});
    }else await require('./explorer-window.cjs').openExplorer({file:target,reveal:Boolean(reveal),shell:require('electron').shell});
  });
  ipcMain.handle('subtitles:details',(_event,id)=>subtitles.details(getWork(id)));
  ipcMain.handle('subtitles:scan',async(_event,{id,force=false})=>subtitles.scan(getWork(id),Boolean(force)));
  ipcMain.handle('subtitles:scan-all',()=>subtitles.startAll(data));
  ipcMain.handle('subtitles:progress',()=>subtitles.progress);
  ipcMain.handle('subtitles:mark',async(_event,{id,path:target,value,all=false})=>{
    const work=getWork(id);if(all===true){await subtitles.markMany(require('./subtitle-index.cjs').filesOf(work),value);return subtitles.details(work);}if(!require('./subtitle-index.cjs').filesOf(work).some(file=>core.normalized(file)===core.normalized(target)))throw Error('只能确认已登记的视频');
    await subtitles.mark(target,value);return subtitles.details(work);
  });
  ipcMain.handle('subtitles:context',(_event,id)=>{
    const work=getWork(id),byTask=new Map();
    for(const file of work.RenameBinding?.files||[]){if(!file.taskId)continue;if(!byTask.has(file.taskId))byTask.set(file.taskId,[]);byTask.get(file.taskId).push(file.path);}
    return {tasks:[...byTask].map(([id,files])=>({id,files})),name:work.Name,chapters:require('./subtitle-matching.cjs').chapterBindings(work)};
  });
  let checking,operation=Promise.resolve();
  const transaction=fn=>{const next=operation.then(fn);operation=next.catch(()=>{});return next;};
  const hydrator=require('./metadata-hydration.cjs').create({data,network,save,thumbnails,transaction,
    notify:()=>{for(const window of require('electron').BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('library:updated');},
    report:result=>fs.promises.writeFile(path.join(directory,'metadata-report.json'),JSON.stringify(result,null,2))});
  const scheduleMetadata=()=>hydrate().catch(error=>console.error('Metadata hydration failed:',error.message));
  ipcMain.handle('library:recheck',async()=>{
    if(!checking)checking=transaction(async()=>{const report=await importBindings();await thumbnails.prepare(data);return {data:decorate(),report};}).then(result=>{scheduleMetadata();return result;}).finally(()=>{checking=null;});
    return checking;
  });
  ipcMain.handle('library:collection',(_event,{id,path:target,episodeIds})=>transaction(async()=>{
    const current=getWork(id);
    require('./file-operations.cjs').select(current,[target],false);
    if(!Array.isArray(episodeIds)||episodeIds.length<2||new Set(episodeIds.map(String)).size!==episodeIds.length)throw Error('合集请选择至少两个不同章节');
    const episodes=await require('./episode-catalog.cjs').loadCatalogue(async offset=>{
      const response=await network.request({url:'https://api.bgm.tv/v0/episodes?subject_id='+encodeURIComponent(current.bgmID)+'&limit=100&offset='+offset});
      if(response.status!==200||response.error)throw Error('无法验证章节，请稍后重试');return JSON.parse(response.body);
    });
    if(episodeIds.some(id=>!episodes.some(ep=>String(ep.id)===String(id))))throw Error('章节不属于当前条目');
    let recent=data.LastWatched,renamedPaths;
    const next=await require('./collection-rename.cjs').renameCollection({work:current,file:target,episodeIds,
      dataDir:integration.dataPath(directory),persist:async(next,previous,mapping)=>{
        recent=core.remapRecent(data.LastWatched,previous,next);renamedPaths=mapping;
        if(data.LastWatched)await save('LastWatched',recent);
        try{await save(id,next);}catch(error){if(data.LastWatched)await save('LastWatched',data.LastWatched);throw error;}
      }});
    data[id]=next;if(data.LastWatched)data.LastWatched=recent;
    const rename=require('./collection-rename.cjs');
    for(const [oldPath,newPath]of renamedPaths||[]){const cached=subtitles.index.get(core.normalized(oldPath));if(cached){subtitles.index.delete(core.normalized(oldPath));subtitles.index.set(core.normalized(newPath),rename.replacePaths(cached,renamedPaths));}}
    await subtitles.save().catch(error=>console.error('Subtitle cache save failed:',error.message));
    return decorate();
  }));
  ipcMain.handle('library:edit',(_event,{id,changes})=>transaction(async()=>{
    const current=data[id];if(!/^WorkSaveNo\d+$/.test(id)||!current)throw Error('番剧不存在');
    const next=coreClone(current);
    for(const [key,value]of Object.entries(changes||{})){
      if(['Name','LocalNotes'].includes(key)){if(typeof value!=='string'||value.length>10000)throw Error('输入内容过长');next[key]=value;}
      else if(key==='DefaultSubtitleGroup'){
        if(typeof value!=='string'||!value.trim()||value.length>120)throw Error('默认字幕组无效');
        next.DefaultSubtitleGroup=value.trim();
      }
      else if(/^(EP|SP)Details\.(EP|SP)\d+\.Condition$/.test(key)&&['Watched','Unwatched'].includes(value)){
        if(!core.getDeep(next,key.split('.').slice(0,-1)))throw Error('章节不存在');core.setDeep(next,key.split('.'),value);
      }else if(/^SpecialEpisodeStates\.[1-9]\d*$/.test(key)&&['Watched','Unwatched'].includes(value)){core.setDeep(next,key.split('.'),value);
      }else throw Error('不支持的修改');
    }
    await save(id,next);data[id]=next;return thumbnails.decorate({work:coreClone(next)}).work;
  }));
  ipcMain.handle('library:clear-records',(_event,{id,paths,all=false})=>transaction(async()=>{
    const operations=require('./file-operations.cjs');let cleared=0;
    const ids=all?Object.keys(data).filter(key=>data[key]?.ExistCondition==='Exist'&&data[key]?.RenameBinding?.invalidResources?.length):[id];
    for(const key of ids){
      const work=data[key];if(!/^WorkSaveNo\d+$/.test(key)||!work)throw Error('番剧不存在');
      const targets=all?work.RenameBinding.invalidResources.map(file=>file.path):paths;
      const next=operations.dismiss(work,targets);await save(key,next);data[key]=next;cleared+=new Set(targets.map(core.normalized)).size;
    }
    return {data:decorate(),cleared};
  }));
  ipcMain.handle('library:trash-file',async(event,{id,path:target})=>{
    const operations=require('./file-operations.cjs');
    if(!/^WorkSaveNo\d+$/.test(id)||!data[id])throw Error('番剧不存在');
    const file=operations.select(data[id],[target],false)[0];
    const before=await fs.promises.lstat(file.path);if(!before.isFile())throw Error('只能删除已登记的视频文件，不能删除目录');
    const {BrowserWindow,dialog,shell}=require('electron');
    const options={type:'warning',title:'删除文件',message:'将这个文件移入系统回收站？',detail:data[id].Name+'\n\n'+file.path+'\n\n同时移除对应管理记录，可从系统回收站恢复。',buttons:['取消','移入回收站'],defaultId:0,cancelId:0,noLink:true};
    const owner=BrowserWindow.fromWebContents(event.sender);
    const answer=owner?await dialog.showMessageBox(owner,options):await dialog.showMessageBox(options);
    if(answer.response!==1)return {cancelled:true};
    return transaction(async()=>{
      const current=data[id];operations.select(current,[file.path],false);
      const after=await fs.promises.lstat(file.path);
      if(!after.isFile()||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('文件发生变化，请重新确认');
      await shell.trashItem(file.path);
      // A successful trash operation is remembered even if the rename record still lists the old output.
      const dismissed=operations.dismiss(current,[file.path],false);
      const group=await require('./file-health.cjs').inspect({id:String(current.bgmID),title:current.Name,files:current.RenameBinding.files},dismissed);
      const next=core.mergeWork(group,dismissed,id);
      const recent=core.remapRecent(data.LastWatched,current,next);
      let warning;
      try{await save(id,next);}catch{warning='文件已移入回收站，但索引保存失败，请点击刷新重试。';}
      data[id]=next;
      if(data.LastWatched){try{await save('LastWatched',recent);}catch{warning='文件已移入回收站，但观看记录保存失败，请点击刷新重试。';}data.LastWatched=recent;}
      return {data:decorate(),trashed:file.path,warning};
    });
  });
  const organizer=integration.create({directory,onReturn:({taskId,checkSubtitles=false}={})=>transaction(async()=>{
    const result=await importBindings({taskId,checkSubtitles});await thumbnails.prepare(data);
    for(const window of require('electron').BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('library:updated');
    return result;
  }).then(result=>{scheduleMetadata();return result;})});
  ipcMain.handle('library:organize',(_event,options)=>{
    // Idle preloading must not trigger first-time storage migration.
    if(options?.preload&&!fs.existsSync(path.join(integration.sourceRoot(),'.bgm-storage.json')))return null;
    return organizer.request('GET','tasks?summary=true');
  });
  ipcMain.handle('organizer:action',async(_event,{action,body})=>{
    if(!['recognize','retry','save-task','plan','check','execute','add-subject','layout','config','save-config','subtitle-preview','subtitle-execute','subtitle-versions','subtitle-manage','subtitle-recover','cancel-review','deepseek-plan','deepseek-history','delete-task-preview','delete-task'].includes(action))throw Error('不支持的整理操作');
    if(action==='subtitle-manage'&&body.mode==='remove'){
      const {dialog,BrowserWindow}=require('electron');
      const current=await organizer.action('subtitle-versions',{ids:body.ids,videos:body.videos});
      let preview;for(;;){const job=await organizer.request('GET','jobs/'+current.job_id);if(job.state==='failed')throw Error(job.error);if(job.state==='completed'){preview=job.result;break;}await new Promise(resolve=>setTimeout(resolve,100));}
      const group=preview.groups.find(group=>group.id===body.group&&group.token===body.token);if(!group)throw Error('字幕已变化，请刷新后重试');
      const result=await dialog.showMessageBox(BrowserWindow.fromWebContents(_event.sender),{type:'warning',buttons:['取消','移入回收站'],defaultId:0,cancelId:0,message:'移除整套字幕？',detail:(group.suffix||'未命名版本')+' · '+group.files.length+' 份字幕\n同步处理已登记的原目录与媒体库字幕；保留视频和其他字幕版本。'});
      if(result.response!==1)return {cancelled:true};
    }
    return organizer.action(action,body);
  });
  const refreshedJobs=new Set();
  const jobRefreshes=new Map();
  ipcMain.handle('organizer:job',async(_event,id)=>{
    if(!/^[a-f0-9]{32}$/.test(id))throw Error('无效作业编号');
    const job=await organizer.request('GET','jobs/'+id);
    if(job.state==='completed'&&['subtitle-manage','subtitle-recover'].includes(job.action)&&!refreshedJobs.has(id)){
      if(!jobRefreshes.has(id))jobRefreshes.set(id,(async()=>{
        const warnings=[],allowed=new Set(Object.values(data).flatMap(work=>require('./subtitle-index.cjs').filesOf(work||{})).map(core.normalized));
        const affected=(job.result?.videos||[]).filter(file=>allowed.has(core.normalized(file)));
        try{await subtitles.scanFiles(affected,{externalOnly:true});}catch(error){warnings.push('字幕已更新，检测结果待刷新：'+error.message);}
        try{if(job.action==='subtitle-manage'&&job.result?.sources?.length)require('./subtitle-inbox.cjs').recordImported(job.result.sources);}catch(error){warnings.push('字幕已导入，下载包处理状态待更新：'+error.message);}
        for(const window of require('electron').BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('library:updated');
        return warnings.join('；');
      })());
      await jobRefreshes.get(id);refreshedJobs.add(id);
    }
    if(job.state==='completed'&&['subtitle-manage','subtitle-recover'].includes(job.action)&&jobRefreshes.has(id)){const warning=await jobRefreshes.get(id);if(warning)job.result={...job.result,warning:[job.result?.warning,warning].filter(Boolean).join('；')};}
    if(job.state==='completed'&&job.action==='delete-task'&&!refreshedJobs.has(id)){
      await transaction(async()=>{
        for(const key of require('./task-library-cleanup.cjs').removedWorks(data,job.task_id)){
          await new Promise((resolve,reject)=>db.remove({_id:key},{},error=>error?reject(error):resolve()));delete data[key];
          if(data.LastWatched)data.LastWatched=data.LastWatched.filter(row=>row.workID!==key);
        }
        if(data.LastWatched)await save('LastWatched',data.LastWatched);
      });
      await organizer.onReturn({taskId:job.task_id});refreshedJobs.add(id);
    }
    if(job.state==='completed'&&['execute','subtitle-execute'].includes(job.action)&&!refreshedJobs.has(id)){
      if(!jobRefreshes.has(id))jobRefreshes.set(id,(async()=>{
        if(job.action==='subtitle-execute'){
          const registered=Object.values(data).flatMap(work=>(work?.RenameBinding?.files||[]).filter(file=>file.taskId===job.task_id).map(file=>file.path));
          const allowed=new Set(registered.map(core.normalized));
          const affected=(job.result?.videos||registered).filter(file=>allowed.has(core.normalized(file)));
          try{if(affected.length)await subtitles.scanFiles(affected,{externalOnly:true});}catch(error){return '字幕已导入，但字幕状态更新失败：'+error.message;}
          for(const window of require('electron').BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('library:updated');
        }else return (await organizer.onReturn({taskId:job.task_id,checkSubtitles:true}))?.warning||'';
        return '';
      })().catch(error=>{jobRefreshes.delete(id);throw error;}));
      const warning=await jobRefreshes.get(id);if(warning)job.result={...job.result,warning};refreshedJobs.add(id);
    }
    if(job.state==='completed'&&['execute','subtitle-execute'].includes(job.action)&&jobRefreshes.has(id)){
      const warning=await jobRefreshes.get(id);if(warning)job.result={...job.result,warning};
    }
    return job;
  });
  ipcMain.handle('organizer:pick',async(event,kind)=>{
    const {dialog,BrowserWindow}=require('electron');
    const options=require('./organizer-picker.cjs').optionsFor(kind);
    const owner=BrowserWindow.fromWebContents(event.sender);
    const result=await dialog.showOpenDialog(owner,options);return result.canceled?[]:result.filePaths;
  });
  ipcMain.handle('library:storage',()=>({directory,renameData:integration.dataPath(directory)}));
  ipcMain.on('library:write',(event,{key,value})=>{
    const resolved=core.resolveKey(data,key),parts=resolved.split('.'),top=parts.shift();
    if(!parts.length)data[top]=value;else{if(!data[top])data[top]={WorkSaveNo:top};core.setDeep(data[top],parts,value);}
    save(top,data[top]).then(()=>{event.returnValue={ok:true};},error=>{event.returnValue={error:error.message};});
  });
  ipcMain.on('library:sort',(event,pref)=>{data.LibrarySort=pref;save('LibrarySort',pref).then(()=>{event.returnValue=core.projection(data);},e=>{event.returnValue={error:e.message};});});
  ipcMain.on('library:clear',event=>{db.remove({},{multi:true},err=>{if(!err)for(const k of Object.keys(data))delete data[k];event.returnValue=err?{error:err.message}:{ok:true};});});
  function hydrate(){return hydrator.hydrate();}
  return {data,report,hydrate,organizer};
}
const coreClone=x=>JSON.parse(JSON.stringify(x));
module.exports={start};
