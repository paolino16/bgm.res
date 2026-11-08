// Render the real folder-picker functions and styles with isolated IPC.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.desktop/source-folder-qa');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}}),js=code=>win.webContents.executeJavaScript(code);
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error(message);});
 try{
  const html=fs.readFileSync(path.join(root,'desktop.html'),'utf8').replace('<script src="js/library-desktop.cjs"></script>','').replace('<head>','<head><base href="'+require('node:url').pathToFileURL(root+path.sep).href+'">');
  fs.writeFileSync(path.join(out,'fixture.html'),html);await win.loadFile(path.join(out,'fixture.html'));
  const source=fs.readFileSync(path.join(root,'js/library-desktop.cjs'),'utf8');
  const picker=source.slice(source.indexOf('function workOriginalFolderButton('),source.indexOf('function fileRow('));
  await js(`
   const path=require('node:path'),{sourcePath}=require(${JSON.stringify(path.join(root,'js/desktop-actions.cjs'))});
   const chromeUI=require(${JSON.stringify(path.join(root,'js/desktop-chrome.cjs'))});chromeUI.install({document,window});
   const appearance=require(${JSON.stringify(path.join(root,'js/desktop-appearance.cjs'))});
   function node(tag,cls='',text=''){const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;}
   function button(text,onclick,cls='button small'){const el=node('button',cls,text);el.type='button';el.onclick=onclick;return chromeUI.decorateButton(el,text);}
   const calls=[],notices=[];let fail=false;
   const ipc={invoke:async(channel,body)=>{calls.push({channel,body});if(fail)throw Error('目录暂时无法访问');}};
   const notice=text=>notices.push(text);
   ${picker}
   const folders=${JSON.stringify(['D:\\ANIME\\TV\\2026-04\\淡岛百景 (2026)\\Season 1','G:\\ANIME\\TV-origin\\[BDrip] Awajima Hyakkei S01 [7³ACG]'])};
   const work={id:'WorkSaveNo1',RenameBinding:{files:folders.map((folder,index)=>({path:'D:/library/video'+index+'.mkv',source:path.join(folder,'original.mkv')}))}};
   document.querySelector('#content').replaceChildren(workOriginalFolderButton(work));document.body.dataset.background='off';void 0;
  `);
  for(const theme of ['codex-dark','codex-light'])for(const width of [1200,760,420]){
   win.setSize(width,800);
   await js(`appearance.applyTheme(document,'${theme}');document.querySelector('#content>button').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   assert.equal(await js(`(()=>{const dialog=document.querySelector('.source-folder-dialog'),rows=[...dialog.querySelectorAll('.source-folder-choice')],bounds=rows.map(row=>row.getBoundingClientRect());return rows.length===2&&rows.every(row=>!row.hasAttribute('data-icon-only')&&row.textContent===folders[rows.indexOf(row)]&&row.getAttribute('aria-label')!=='打开原视频文件夹')&&bounds[1].top>=bounds[0].bottom&&rows.every(row=>row.scrollWidth<=row.clientWidth+1)&&dialog.scrollWidth<=dialog.clientWidth+1&&dialog.getBoundingClientRect().right<=innerWidth&&parseInt(getComputedStyle(dialog).padding)===20;})()`),true);
   fs.writeFileSync(path.join(out,theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
   await js(`document.querySelector('.source-folder-actions button').click();new Promise(resolve=>requestAnimationFrame(resolve))`);
   assert.equal(await js(`!document.querySelector('.source-folder-dialog')`),true);
  }
  await js(`document.querySelector('#content>button').click();fail=true;document.querySelectorAll('.source-folder-choice')[1].click();new Promise(resolve=>setTimeout(resolve,20))`);
  assert.equal(await js(`document.querySelector('.source-folder-dialog').open&&notices.at(-1)==='目录暂时无法访问'`),true);
  await js(`fail=false;document.querySelectorAll('.source-folder-choice')[1].click();new Promise(resolve=>setTimeout(resolve,20))`);
  assert.equal(await js(`!document.querySelector('.source-folder-dialog')&&calls.at(-1).body.path===work.RenameBinding.files[1].path&&calls.at(-1).body.original===true`),true);
  await js(`document.querySelector('#content>button').click();document.querySelector('.source-folder-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));document.querySelector('.source-folder-dialog').close();new Promise(resolve=>requestAnimationFrame(resolve))`);
  console.log('Folder picker: six theme/width layouts, separate wrapped paths, cancel, successful selection and failed-open recovery passed.');
 }finally{win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
