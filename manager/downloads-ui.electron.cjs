// Isolated download UI verification. No live IPC, qBit or library writes.
'use strict';
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.desktop','downloads-qa');
fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1360,height:860,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}});
  const js=code=>win.webContents.executeJavaScript(code);
  try{
    // Retain the real app markup and styles, replacing only its renderer entry point.
    const html=fs.readFileSync(path.join(root,'desktop.html'),'utf8').replace('<script src="js/library-desktop.cjs"></script>','');
    const fixture=path.join(out,'fixture.html');
    fs.writeFileSync(fixture,html.replace('<head>','<head><base href="'+require('node:url').pathToFileURL(root+path.sep).href+'">'));
    await win.loadFile(fixture);
    await js(`
      const {downloads}=require(${JSON.stringify(path.join(root,'js/qbit-ui.cjs'))});
      const chromeUI=require(${JSON.stringify(path.join(root,'js/desktop-chrome.cjs'))});
      function node(tag,cls='',text=''){const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;}
      function button(text,click,cls){const el=node('button',cls,text);el.onclick=click;return chromeUI.decorateButton(el,text);}
      chromeUI.install({document,window});
      document.body.dataset.theme='codex-dark';
      document.querySelector('#toolbar').hidden=true;
      const rows=[
        {hash:'a',title:'取消了添加窗口的下载',stage:'unconfirmed'},
        {hash:'b',title:'磁力正在解析',stage:'waiting'},
        {hash:'c',title:'星际牛仔 · 待审核',stage:'ready',taskId:'review',libraryStatus:'pending'},
        {hash:'d',title:'星际牛仔 · 已执行入库',stage:'failed',error:'历史识别错误',taskId:'done',libraryStatus:'imported'},
        {hash:'e',title:'已放弃的方案',stage:'ready',taskId:'cancelled',libraryStatus:'cancelled'},
        {hash:'f',title:'后台暂时不可用',stage:'ready',taskId:'unknown',libraryStatus:'unknown',libraryError:'入库状态暂时无法确认：连接中断'},
        {hash:'g',title:'下载进度',stage:'downloading',state:'downloading',progress:0.625,speed:2097152,eta:750}
      ];
      const opened=[],commands=[];
      const ui=downloads({node,button,notice:message=>{throw Error(message);},openTask:async id=>{opened.push(id);},openSettings(){},container:()=>document.querySelector('#content'),
        setHeader:(title,subtitle)=>{document.querySelector('#page-title').textContent=title;document.querySelector('#page-subtitle').textContent=subtitle;},
        ipc:{invoke:async(channel,body)=>{
          if(channel==='downloads:list')return {rows};
          commands.push(body);
          for(let i=rows.length-1;i>=0;i--)if(body.command==='clear-unconfirmed'?rows[i].stage==='unconfirmed':rows[i].hash===body.hash)rows.splice(i,1);
        }}});
      ui.render();void 0;
    `);
    assert.equal(await js(`document.querySelector('.download-list').textContent.includes('待审核入库') && document.querySelector('.download-list').textContent.includes('已入库') && document.querySelector('.download-list').textContent.includes('预估剩余 12分 30秒')`),true);
    await js(`[...document.querySelectorAll('button')].find(el=>el.textContent==='审核并入库').click()`);
    assert.deepEqual(await js('opened'),['review']);
    assert.equal(await js(`!document.querySelector('.download-list').textContent.includes('历史识别错误') && ![...document.querySelectorAll('.resource-row')].find(el=>el.textContent.includes('已执行入库')).textContent.includes('重试识别')`),true);
    assert.equal(await js(`[...document.querySelectorAll('.download-list button')].every(el=>el.hasAttribute('data-icon-only') && el.getAttribute('aria-label') && el.querySelector('svg'))`),true);
    for(const width of [1360,760]){
      win.setSize(width,860);
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
      assert.deepEqual(await js(`[...document.querySelectorAll('.download-list button')].map(el=>({label:el.getAttribute('aria-label'),width:Math.round(el.getBoundingClientRect().width),position:getComputedStyle(el.querySelector('.control-label')).position}))`),await js(`[...document.querySelectorAll('.download-list button')].map(el=>({label:el.getAttribute('aria-label'),width:34,position:'absolute'}))`));
      fs.writeFileSync(path.join(out,'downloads-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    // Offscreen windows have no native focus; send the same bubbling event as keyboard focus.
    await js(`document.querySelector('[aria-label="查看整理任务"]').dispatchEvent(new FocusEvent('focusin',{bubbles:true}));new Promise(resolve=>setTimeout(resolve,50))`);
    assert.equal(await js(`!document.querySelector('.control-tooltip').hidden && document.querySelector('.control-tooltip').textContent==='查看整理任务'`),true);
    await js(`document.querySelector('[aria-label="清除记录"]').dispatchEvent(new FocusEvent('focusin',{bubbles:true}));new Promise(resolve=>setTimeout(resolve,50))`);
    assert.equal(await js(`document.querySelector('.control-tooltip').textContent.includes('保留 qBit 任务、文件和媒体库内容')`),true);
    await js(`[...document.querySelectorAll('button')].find(el=>el.textContent==='清理未添加记录').click()`);
    assert.equal(await js(`!document.querySelector('.download-list').textContent.includes('取消了添加窗口') && document.querySelectorAll('.resource-row').length===6`),true);
    await js(`[...document.querySelectorAll('.resource-row')].find(el=>el.textContent.includes('磁力正在解析')).querySelector('button').click()`);
    assert.equal(await js(`document.querySelectorAll('.resource-row').length===5`),true);
    console.log('Download UI: actual statuses, review navigation, safe cleanup and 1360/760px layout passed.');
  }finally{win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
