const {app,BrowserWindow,shell,dialog}=require('electron');
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
app.setName('bgm-res-manager');
app.setPath('userData',path.join(app.getPath('appData'),'bgm-res-manager'));
let backend,win,baseURL;
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(()=>{
    const node=process.env.BGM_MANAGER_NODE;
    if(!node)throw Error('请使用“启动收藏管理.cmd”启动，以加载数据库运行时。');
    backend=spawn(node,[path.join(__dirname,'desktop-server.cjs')],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    let errors='';backend.stderr.on('data',data=>errors+=data.toString());
    backend.on('message',message=>{if(message.openPath)shell.showItemInFolder(message.openPath);});
    const lines=readline.createInterface({input:backend.stdout});
    lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      if(!message.url||win)return;baseURL=message.url;
      win=new BrowserWindow({width:1320,height:900,minWidth:960,minHeight:640,backgroundColor:'#f6f5f2',autoHideMenuBar:true,icon:path.join(__dirname,'../assets/icons/app.ico'),webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      win.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\/bgm\.tv\/subject\/\d+$/.test(url))shell.openExternal(url);return {action:'deny'};});
      win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==baseURL)event.preventDefault();});
      win.loadURL(baseURL);win.on('closed',()=>{win=null;app.quit();});
    });
    backend.on('exit',code=>{if(win){dialog.showErrorBox('收藏服务已停止',errors.slice(-2000)||`退出代码 ${code}`);app.quit();}});
    setTimeout(()=>{if(!win){dialog.showErrorBox('收藏管理启动失败',errors.slice(-2000)||'数据库服务未就绪，请检查 Node.js 运行时。');app.quit();}},20000).unref();
  }).catch(e=>{dialog.showErrorBox('启动失败',e.message);app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('will-quit',()=>{if(backend)backend.kill();});
}
