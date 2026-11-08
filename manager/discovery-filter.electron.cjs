// Isolated discovery filtering regression, with a simulated large local library.
'use strict';
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.desktop','discovery-filter-qa');
fs.mkdirSync(out,{recursive:true});
for(const name of ['report.json','failure.txt','console.txt'])fs.rmSync(path.join(out,name),{force:true});
app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1360,height:860,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}});
  const js=code=>win.webContents.executeJavaScript(code);
  win.webContents.on('console-message',(_,level,message)=>fs.appendFileSync(path.join(out,'console.txt'),message+'\n'));
  try{
    const html=fs.readFileSync(path.join(root,'desktop.html'),'utf8').replace('<script src="js/library-desktop.cjs"></script>','');
    const fixture=path.join(out,'fixture.html');
    fs.writeFileSync(fixture,html.replace('<head>','<head><base href="'+require('node:url').pathToFileURL(root+path.sep).href+'">'));
    await win.loadFile(fixture);
    await js(`
      const {create}=require(${JSON.stringify(path.join(root,'js/discovery-ui.cjs'))});
      window.addEventListener('error',event=>console.error(event.error?.stack||event.message));
      window.addEventListener('unhandledrejection',event=>console.error(event.reason?.stack||event.reason));
      function node(tag,cls='',text=''){const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;}
      function button(text,click,cls){const el=node('button',cls,text);el.onclick=click;return el;}
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      async function ready(){for(let i=0;i<400;i++){if(document.querySelector('.discovery-results')?.getAttribute('aria-busy')!=='true')return;await wait(10);}throw Error('discovery timed out');}
      document.body.dataset.theme='codex-dark';document.querySelector('#toolbar').hidden=true;
      const localWorks=Array.from({length:900},(_,i)=>({id:'work'+i,bgmID:i+1}));
      const requests=[];let running=0,peak=0;
      const ui=create({node,button,works:()=>localWorks,container:()=>document.querySelector('#content'),setHeader:(title)=>{document.querySelector('#page-title').textContent=title;},
        ipc:{invoke:async(channel,q)=>{
          if(channel==='discovery:status')return {revision:0,username:'',supportsRankFilters:true,apiTagSorting:true};
          if(channel!=='discovery:page')throw Error(channel);
          requests.push(q);peak=Math.max(peak,++running);await wait(10);running--;
          const count=Math.min(q.scan?50:24,1000-q.offset);
          return {total:1000,count,rows:Array.from({length:count},(_,i)=>({id:q.offset+i+1,rank:q.offset+i+1,name:'测试动画 '+(q.offset+i+1),cn:'',date:'2025-01-01'}))};
        }}});
      function toggle(){const control=document.querySelector('.discovery-missing input');control.checked=!control.checked;control.dispatchEvent(new Event('change'));}
      ui.render().then(async()=>{
        await wait(30);requests.length=0;
        const started=performance.now();toggle();await ready();
        window.filterMs=Math.round(performance.now()-started);
      });
    `);
    assert.equal(await js(`document.querySelector('.discovery-rank').textContent`),'#901');
    assert.equal(await js(`document.querySelectorAll('.discovery-row').length`),24);
    assert.equal(await js(`requests.every(q=>q.scan===true) && peak<=3`),true);
    const count=await js('requests.length');
    await js(`wait(80)`);
    assert.equal(await js('requests.length'),count,'no unbounded background scan');
    await js(`[...document.querySelectorAll('button')].find(el=>el.textContent==='下一页'||el.getAttribute('aria-label')==='下一页').click();ready()`);
    assert.equal(await js(`document.querySelector('.discovery-rank').textContent`),'#925');
    await js(`toggle();ready().then(()=>{toggle();return ready();})`);
    assert.equal(await js(`document.querySelector('.discovery-rank').textContent`),'#901');
    assert.equal(await js('requests.filter(q=>q.scan).length'),count,'reuse filtered batches on toggle');
    await js(`localWorks.push({id:'new',bgmID:901});ui.refreshLibrary();ready()`);
    assert.equal(await js(`document.querySelector('.discovery-rank').textContent`),'#902');
    for(const width of [1360,760]){
      win.setSize(width,860);await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await js(`document.querySelector('#content').scrollWidth<=document.querySelector('#content').clientWidth+2`),true);
      fs.writeFileSync(path.join(out,'filtered-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    const report=await js('({milliseconds:filterMs,requests:requests.filter(q=>q.scan).length,peak})');
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log('Discovery filter UI passed:',report);
  }catch(error){fs.writeFileSync(path.join(out,'failure.txt'),error.stack);throw error;}
  finally{win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
