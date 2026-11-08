// Real renderer components with isolated IPC and no user library or program launches.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.desktop','cadensview-qa');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}}),js=code=>win.webContents.executeJavaScript(code);
 try{
  const html=fs.readFileSync(path.join(root,'desktop.html'),'utf8').replace('<script src="js/library-desktop.cjs"></script>','').replace('<head>','<head><base href="'+require('node:url').pathToFileURL(root+path.sep).href+'">');
  fs.writeFileSync(path.join(out,'fixture.html'),html);await win.loadFile(path.join(out,'fixture.html'));
  const source=fs.readFileSync(path.join(root,'js/library-desktop.cjs'),'utf8'),chapter=source.slice(source.indexOf('function chapterCard('),source.indexOf('function chapterActions('));
  await js(`
   const chromeUI=require(${JSON.stringify(path.join(root,'js/desktop-chrome.cjs'))});chromeUI.install({document,window});
   const appearance=require(${JSON.stringify(path.join(root,'js/desktop-appearance.cjs'))});
   function node(tag,cls='',text=''){const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;}
   function button(text,onclick,cls='button small'){const el=node('button',cls,text);el.type='button';el.onclick=onclick;return chromeUI.decorateButton(el,text);}
   const calls=[],notices=[],listeners={};let fail='',state={path:'F:\\\\softwares\\\\CadensView-0.1.0-win-x64\\\\CadensView.exe',version:'0.1.0',automatic:true,latest:{version:'0.3.0',url:'https://github.com/dddkkw/CadensView/releases/tag/v0.3.0',notes:'新增洋葱皮模式、帧间变化分析及分镜表 PDF 导出。'}};
   const ipc={on:(name,fn)=>listeners[name]=fn,invoke:async(channel,body)=>{calls.push({channel,body});if(fail&&channel!=='cadensview:status')throw Error(fail);if(channel==='cadensview:open')return {};if(channel==='cadensview:configure')state={...state,...body};return state;}};
   const shell={openExternal:url=>calls.push({url})},notice=text=>notices.push(text),activeWork=()=>({id:'WorkSaveNo1'}),openFile=()=>{},bangumiDuration=()=>null;
   const cadensviewUI=require(${JSON.stringify(path.join(root,'js/cadensview-ui.cjs'))}).create({ipc,node,button,notice,shell});
   ${chapter}
   function render(){const content=document.querySelector('#content');content.replaceChildren();document.body.dataset.view='settings';document.body.dataset.background='off';document.querySelector('#page-title').textContent='偏好设置';document.querySelector('#toolbar').hidden=document.querySelector('#filters').hidden=true;cadensviewUI.settings(content);const grid=node('div','chapter-grid');for(const file of ['D:/中文 视频.mkv',null])grid.append(chapterCard({label:file?'EP 1':'EP 2',title:'鉴赏操作验证',actions:episodeActions({file,link:'https://bgm.tv/ep/1',onToggle:()=>{},onThrough:()=>{},throughTitle:'看到这里'},'chapter-actions')}));content.append(grid);}
   render();void 0;
  `);
  for(const theme of ['codex-dark','codex-light'])for(const width of [1200,760,420]){
   win.setSize(width,900);await js(`appearance.applyTheme(document,'${theme}');new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
   assert.equal(await js(`(()=>{const root=document.querySelector('.cadensview-settings');return root.scrollWidth<=root.clientWidth+1&&document.querySelector('#content').scrollWidth<=document.querySelector('#content').clientWidth+1&&[...document.querySelectorAll('.chapter')].every(card=>{const a=card.querySelector('.chapter-actions'),rect=a.getBoundingClientRect();return [...a.children].every(b=>{const r=b.getBoundingClientRect();return r.left>=rect.left&&r.right<=rect.right+1&&r.bottom<=rect.bottom+1;});});})()`),true,theme+' '+width+' fits');
   const point=await js(`(()=>{const r=document.querySelector('.chapter').getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+30)};})()`);
   win.webContents.sendInputEvent({type:'mouseMove',...point});
   await js(`new Promise(r=>setTimeout(r,220))`);
   assert.equal(await js(`getComputedStyle(document.querySelector('.chapter-actions')).visibility==='visible'`),true,'hover actions visible');
   fs.writeFileSync(path.join(out,theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  assert.equal(await js(`document.querySelectorAll('[aria-label="鉴赏"]')[1].disabled`),true);
  await js(`document.querySelector('[aria-label="鉴赏"]').click();new Promise(r=>setTimeout(r,20))`);
  assert.equal(await js(`calls.some(c=>c.channel==='cadensview:open'&&c.body.id==='WorkSaveNo1'&&c.body.path==='D:/中文 视频.mkv')`),true);
  await js(`fail='下载失败，请重试';[...document.querySelectorAll('.cadensview-settings button')].find(b=>b.textContent==='下载更新').click();new Promise(r=>setTimeout(r,30))`);
  assert.equal(await js(`document.querySelector('.cadensview-settings [role=status]').textContent==='下载失败，请重试'&&[...document.querySelectorAll('.cadensview-settings button')].find(b=>b.textContent==='下载更新').disabled===false`),true);
  await js(`fail='';listeners['cadensview:update'](null,{event:'progress',phase:'download',received:50,total:100});void 0`);
  assert.equal(await js(`document.querySelector('.cadensview-settings [role=status]').textContent.includes('50%')&&document.querySelector('.cadensview-settings input[type=checkbox]').disabled`),true);
  await js(`state={...state,pending:{version:'0.3.0'},progress:null};listeners['cadensview:update'](null,{...state,event:'installed'});void 0`);
  assert.equal(await js(`document.querySelector('.cadensview-settings [role=status]').textContent.includes('关闭 CadensView')`),true);
  console.log('CadensView UI: six theme/width layouts, five chapter actions, disabled missing file, exact-file IPC, retry, download progress and pending switch passed.');
 }finally{win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
