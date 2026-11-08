const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.desktop/subtitle-versions-qa');fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:860,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}}),js=code=>win.webContents.executeJavaScript(code);
 try{
  const html=fs.readFileSync(path.join(root,'desktop.html'),'utf8').replace('<script src="js/library-desktop.cjs"></script>','').replace('<head>','<head><base href="'+require('url').pathToFileURL(root+path.sep).href+'">');const fixture=path.join(out,'fixture.html');fs.writeFileSync(fixture,html);await win.loadFile(fixture);
  await js(`
   const chromeUI=require(${JSON.stringify(path.join(root,'js/desktop-chrome.cjs'))});chromeUI.install({document,window});
   function node(tag,cls='',text=''){const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;}
   function button(text,onclick,cls='button small'){const el=node('button',cls,text);el.type='button';el.onclick=onclick;return chromeUI.decorateButton(el,text);}
   document.body.dataset.background='off';const appearance=require(${JSON.stringify(path.join(root,'js/desktop-appearance.cjs'))});appearance.applyTheme(document,'codex-dark');document.querySelector('#content').replaceChildren();document.querySelector('#toolbar').hidden=true;document.querySelector('#page-title').textContent='字幕';document.querySelector('#page-subtitle').textContent='星际牛仔 · 隔离界面验证';
   const videos=Array.from({length:12},(_,i)=>'D:/library/星际牛仔 - '+String(i+1).padStart(2,'0')+'.mkv');
   const makeGroup=(suffix,count)=>({id:suffix.toLowerCase(),suffix,token:suffix,videos:videos.slice(0,count),formats:['ASS'],files:videos.slice(0,count).map(video=>({path:video.replace('.mkv','.'+suffix+'.ass'),video}))});
   const inventory={groups:[makeGroup('chs.字幕组A',12),makeGroup('cht.字幕组A',8)],videos};
   const report={summary:{total:12,covered:12},files:videos.map(video=>({path:video,state:'checked',internal:[{language:'ja',codec:'ass'}],external:inventory.groups.flatMap(group=>group.files.filter(file=>file.video===video).map(file=>file.path))}))};
   const context={tasks:[{id:'task',files:videos}],chapters:videos.map((video,i)=>({id:'EP'+(i+1),number:i+1,videos:[video]}))};
   const incoming=Array.from({length:12},(_,i)=>'D:/inbox/字幕组B - '+String(i+1).padStart(2,'0')+'.ass');
   const inbox=[{id:'package',name:'字幕组B · 简繁日全集.zip',folder:'D:/inbox',workId:'previous',workName:'其他作品',files:Array.from({length:24},(_,i)=>({path:'file'+i,state:i<12?'imported':'pending'})),done:12,remaining:incoming,state:'pending'}];
   let sequence=0;const jobs=new Map(),calls=[],notices=[];
   const ipc={async invoke(channel,body){calls.push({channel,body});if(channel==='subtitle-inbox:list')return inbox;if(channel==='subtitle-inbox:command')return {};if(channel==='subtitles:details'||channel==='subtitles:scan')return report;if(channel==='subtitles:context')return context;if(channel==='organizer:pick')return incoming;
    if(channel==='organizer:job')return jobs.get(body);
    if(channel==='organizer:action'){const id=String(++sequence);let result;if(body.action==='subtitle-versions')result=inventory;else if(body.action==='subtitle-preview')result={videos,rows:body.body.files.map((source,i)=>({source,video:videos[i],suffix:'chs',reason:'已按集数匹配'}))};else if(body.action==='subtitle-manage'){result={count:body.body.rows?.length||12};if(body.body.mode==='remove')inventory.groups=inventory.groups.filter(group=>group.id!==body.body.group);}else throw Error(body.action);jobs.set(id,{state:'completed',result});return {job_id:id};}throw Error(channel);}};
   const panel=require(${JSON.stringify(path.join(root,'js/subtitle-panel.cjs'))}).create({ipc,node,button,notice:text=>notices.push(text),refresh:async()=>{}});panel.mount({id:'demo',Name:'星际牛仔'},document.querySelector('#content'));void 0;
  `);
  await js('new Promise(resolve=>setTimeout(resolve,100))');
  assert.equal(await js(`document.querySelectorAll('.subtitle-version').length===2&&!document.querySelector('.subtitle-detection-details').open&&!document.querySelector('.subtitle-import-compact').open&&document.querySelector('.subtitle-version-copy').textContent.includes('12 / 12 集')`),true);
  for(const theme of ['codex-dark','codex-light'])for(const width of [1200,760]){win.setSize(width,860);await js(`appearance.applyTheme(document,'${theme}');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('#content').scrollWidth<=document.querySelector('#content').clientWidth+1`),true);fs.writeFileSync(path.join(out,'versions-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
  win.setSize(1200,900);await js(`appearance.applyTheme(document,'codex-dark');document.querySelector('[aria-label="字幕收件箱"]').click();new Promise(resolve=>setTimeout(resolve,50))`);
  assert.equal(await js(`!document.querySelector('.subtitle-inbox-list').hidden&&document.querySelector('.subtitle-inbox-list').textContent.includes('已导入 12 / 24')`),true);
  fs.writeFileSync(path.join(out,'inbox.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('[aria-label="继续导入"]').click();new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await js(`calls.some(call=>call.channel==='subtitle-inbox:command'&&call.body.command==='assign'&&call.body.workId==='demo')&&calls.some(call=>call.body?.action==='subtitle-preview'&&call.body.body.files.length===12)`),true);
  await js(`document.querySelector('[aria-label="批量字幕语言"]').value='chs';document.querySelector('[aria-label="批量字幕组"]').value='字幕组A';document.querySelector('[aria-label="应用字幕后缀"]').click();document.querySelector('.subtitle-inbox-list').hidden=true;document.querySelector('.subtitle-import-footer').scrollIntoView({block:'center'});void 0`);
  assert.equal(await js(`!document.querySelector('[data-subtitle-execute]').disabled&&document.querySelector('[data-subtitle-count]').textContent.includes('目标重名')&&document.querySelector('[data-subtitle-count]').textContent.includes('直接替换')`),true);
  for(const theme of ['codex-dark','codex-light'])for(const width of [1200,760]){win.setSize(width,900);await js(`appearance.applyTheme(document,'${theme}');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);assert.equal(await js(`document.querySelector('#content').scrollWidth<=document.querySelector('#content').clientWidth+1`),true);fs.writeFileSync(path.join(out,'collision-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
  await js(`document.querySelector('[data-subtitle-execute]').click();new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await js(`calls.some(call=>call.body?.action==='subtitle-manage'&&call.body.body.mode==='add'&&call.body.body.rows.every(row=>row.suffix==='chs.字幕组A'))`),true);
  await js(`document.querySelectorAll('[aria-label="替换字幕版本"]')[0].click();document.querySelector('[aria-label="选择字幕文件"]').click();new Promise(resolve=>setTimeout(resolve,50))`);
  await js(`document.querySelector('.subtitle-source-controls .primary').click();new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await js(`document.querySelector('[aria-label="导入方式"]').value==='replace'&&!document.querySelector('.subtitle-match-details').open&&!document.querySelector('[data-subtitle-execute]').disabled`),true);
  await js(`const language=document.querySelector('[aria-label="批量字幕语言"]');language.value='chs';language.dispatchEvent(new Event('change'));const group=document.querySelector('[aria-label="批量字幕组"]');group.value='字幕组B';group.dispatchEvent(new Event('input'));document.querySelector('[aria-label="应用字幕后缀"]').click();document.querySelector('.subtitle-inbox-list').hidden=true;document.querySelector('.subtitle-import-compact').scrollIntoView({block:'start'});void 0`);
  for(const width of [1200,760]){win.setSize(width,900);await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);assert.equal(await js(`document.querySelector('#content').scrollWidth<=document.querySelector('#content').clientWidth+1`),true);fs.writeFileSync(path.join(out,'import-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
  await js(`document.querySelector('[data-subtitle-execute]').click();new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await js(`calls.some(call=>call.body?.action==='subtitle-manage'&&call.body.body.mode==='replace'&&call.body.body.rows.length===12&&call.body.body.rows.every(row=>row.suffix==='chs.字幕组B'))`),true);
  await js(`document.querySelector('[aria-label="移除字幕版本"]').click();new Promise(resolve=>setTimeout(resolve,100))`);
  assert.equal(await js(`document.querySelectorAll('.subtitle-version').length===1&&calls.some(call=>call.body?.action==='subtitle-manage'&&call.body.body.mode==='remove')`),true);
  console.log('Grouped versions, dark/light desktop/narrow layouts, inbox continuation, batch suffix, replacement and removal passed.');
 }finally{win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
