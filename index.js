/* Main Progress of Kanban Desktop */

const { app ,BrowserWindow, Menu , Tray, shell, ipcRenderer,ipcMain, nativeTheme} = require('electron')
const dialog = require('electron').dialog;
const path = require('path');
var packageGet = require("./package.json");
const { PARAMS, VALUE,  MicaBrowserWindow, IS_WINDOWS_11, WIN10 } = require('mica-electron'); //导入Mica Electron
require('@electron/remote/main').initialize(); //初始化dialog renderer
const Store = require('electron-store'); Store.initRenderer(); //初始化electron-store
let SysdataOption={
  name:"sysdata",//文件名称,默认 config
  fileExtension:"json",//文件后缀,默认json
}; const sysdata = new Store(SysdataOption); if(!sysdata.get("Settings")) sysdata.set(require("./sysdata_default.json"));                          //?创建electron-store存储资源库对象-系统设置存储
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
let mainWindow = null;
app.on('second-instance', (_event, commandLine) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const callback = commandLine.find(argument => /^bgmres:/i.test(argument));
  if (callback) mainWindow.webContents.send('logincode', decodeURI(callback));
});

function createWindow () {
    const screenElectron = require('electron').screen;
    const display = screenElectron.getDisplayNearestPoint(screenElectron.getCursorScreenPoint());
    const desktopBounds = require('./js/desktop-window.cjs').desktopBounds(display.workArea);
    var win = null; //?主程序窗口对象
    // 创建主程序浏览器窗口
    if(sysdata.get("Settings.checkboxB.LocalStorageSystemOpenMicaMode")==true) //!启用 Acrylic window
    {
      win = new MicaBrowserWindow({
        ...desktopBounds,
        //x: screenElectron.getPrimaryDisplay().workAreaSize.width-360,
        //y: screenElectron.getPrimaryDisplay().workAreaSize.height-500,
        alwaysOnTop: false,        //不置顶显示
        transparent: false,        //底部透明
        autoHideMenuBar: true,
        show: false,
        frame: true,
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#202020",
          symbolColor: "white", },
        maximizable: true,
        minimizable: true,
        resizable: true,           //窗口可调节大小
        icon: path.join(__dirname, './assets/icons/app.ico'),
        webPreferences: {
          devTools: true,
          nodeIntegration: true,
          enableRemoteModule: true,
          contextIsolation: false,
          webviewTag: true,
          zoomFactor: 1,

        }
      })

      win.setAcrylic();

      // if(IS_WINDOWS_11)  {win.setMicaTabbedEffect();win.setAutoTheme();} else if(WIN10) 

      // 并且为你的应用加载index.html
      win.webContents.setUserAgent(`JimHan/bgm.res/${packageGet.version} (Windows) (https://github.com/JimHans/bgm.res)`);
      win.loadFile(path.join(__dirname, 'desktop.html'));

      require('@electron/remote/main').enable(win.webContents) // 启用 electron/remote web组件

      win.once('ready-to-show', () => {
        SetDockerTasks(); //设置任务栏快速任务
        win.show();
      })
      // win.webContents.openDevTools();
    }   
    else  //!不启用 Acrylic window
    {
      win = new BrowserWindow({
        ...desktopBounds,
        //x: screenElectron.getPrimaryDisplay().workAreaSize.width-360,
        //y: screenElectron.getPrimaryDisplay().workAreaSize.height-500,
        alwaysOnTop: false,        //不置顶显示
        transparent: false,        //底部透明
        autoHideMenuBar: true,
        show: false,
        frame: true,
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#202020",
          symbolColor: "white", },
        maximizable: true,
        minimizable: true,
        resizable: true,           //窗口可调节大小
        icon: path.join(__dirname, './assets/icons/app.ico'),
        webPreferences: {
          devTools: true,
          nodeIntegration: true,
          enableRemoteModule: true,
          contextIsolation: false,
          webviewTag: true,
          zoomFactor: 1,

        }
      })
    
      // 并且为你的应用加载index.html
      win.webContents.setUserAgent(`JimHan/bgm.res/${packageGet.version} (Windows) (https://github.com/JimHans/bgm.res)`);
      win.loadFile(path.join(__dirname, 'desktop.html'));

      require('@electron/remote/main').enable(win.webContents) // 启用 electron/remote web组件

      win.once('ready-to-show', () => {
        SetDockerTasks(); //设置任务栏快速任务
        win.show();
      })
      // win.webContents.openDevTools();
    }

    mainWindow = win;
    win.on('closed', function() {
      mainWindow = null;
      app.quit();});
//系统托盘右键菜单
var trayMenuTemplate = [
    {
      label: 'bgm.res',
      enabled: false,
      icon: path.join(__dirname, './assets/icons/TrayMenu.png')
    },
    {
      type: 'separator'
    }, //分隔线
    {
      label: '正在观看',
      click: function () {win.show();win.webContents.send('MainWindow','OpenWatchingPage');} //打开相应页面
    },
    {
      label: '媒体库',
      click: function () {win.show();win.webContents.send('MainWindow','OpenMediaPage');} //打开相应页面
    },
    {
      label: '资源整理',
      click: function () {win.show();win.webContents.send('MainWindow','OpenOrganizerPage');} //打开相应页面
    },
    {
      label: '设置',
      submenu: [
        {
          label: '偏好设置',
          click: function () {win.show();win.webContents.send('MainWindow','OpenSettingsPage');} //打开相应页面
        },
        {
          label: '开启总在最上',
          type: 'checkbox',
          checked: false,
          click: (menuItem) => {
            // 处理单击事件
            if(menuItem.checked==true){win.setAlwaysOnTop(true);}//设置总在最上settings.setAlwaysOnTop(true);
            else if(menuItem.checked==false){win.setAlwaysOnTop(false);}//取消设置总在最上settings.setAlwaysOnTop(false);
          }
        }
      ]
    },
    {
      type: 'separator'
    }, //分隔线
    {
      label: '关于',
      click: function () {
        dialog.showMessageBox({
          title  : '关于', 
          type  : 'info', 
          message : packageGet.name+" v"+packageGet.version+packageGet.buildinf+' Powered By Electron™.'
        })
      } //打开相应页面
    },
    // {
      // submenu: [
      //   {
      //     label: '开启总在最上',
      //     click: function () {win.setAlwaysOnTop(true);}, //设置总在最上settings.setAlwaysOnTop(true);
      //     type: 'radio'
      //   },
      //   {
      //     label: '关闭总在最上',
      //     click: function () {win.setAlwaysOnTop(false);}, //取消设置总在最上settings.setAlwaysOnTop(false);
      //     type: 'radio'
      //   },
      // ],
    // },
    {
        label: '退出',
        click: function () {
          dialog.showMessageBox({
            type:"info",
            buttons:["告辞！","我手滑了"],
            title:"退出",
            message:`真的要退出嘛？`
          }).then((result)=>{
              if(result.response==0){
                  console.log("确定");app.quit();
              }else if(result.response==1){
                  console.log("取消")
              }
          }).catch((error)=>{
              console.log(error);
          });
        }
    }
];

ipcMain.on("MainWindow",(event,data) => {
  const owner=BrowserWindow.fromWebContents(event.sender);
  if(owner&&owner!==win){
    if(data==='Close'){owner.close();return;}
    if(data==='Hide'){owner.minimize();return;}
    if(data==='Refresh'){owner.reload();return;}
  }
  console.log(data);
  if(data == 'Close') {event.preventDefault();app.quit();}
  if(data == 'Hide') {event.preventDefault();win.hide();}
  if(data == 'Refresh') {win.reload();}
  if(data.slice(0,18) == 'RefreshArchivePage') {win.webContents.send('data',data);}
  if(data.slice(0,15) == 'InitArchivePage') {win.webContents.send('data',data);}
});//监听主程序标题栏操作最小化与关闭、刷新

//开发人员工具打开监听
ipcMain.on("dev",(event,data) => {
  console.log(data); 
  if(data == 'Open') {win.webContents.openDevTools();}
});

//图标的上下文菜单
trayIcon = path.join(__dirname, 'assets/icons');//选取目录
tray = new Tray(path.join(trayIcon, 'app.ico'));
let contextMenu = Menu.buildFromTemplate(trayMenuTemplate);

tray.on('click', function() {
  // 显示主程序
  win.show();
});//设置点击托盘显示主程序

//设置此托盘图标的悬停提示内容
tray.setToolTip(packageGet.name+" v"+packageGet.version);

app.setAppUserModelId(packageGet.name+" v"+packageGet.version);
//设置此图标的上下文菜单
tray.setContextMenu(contextMenu);

app.setAsDefaultProtocolClient('bgmres');
//注册唤醒链接，处理回调数据
}

// Electron会在初始化完成并且准备好创建浏览器窗口时调用这个方法
// 部分 API 在 ready 事件触发后才能使用。
if (hasInstanceLock) app.whenReady().then(async () => { const linked = await require('./js/rename-binding-main.cjs').start({ipcMain, app, sysdata, Datastore: require('nedb')}); createWindow(); linked.hydrate().catch(error => console.error('Metadata hydration failed:', error.message)); }).catch(error => { dialog.showErrorBox('重命名产物绑定失败', error.message); app.quit(); })

//当所有窗口都被关闭后退出
app.on('window-all-closed', () => {
  // 在 macOS 上，除非用户用 Cmd + Q 确定地退出，
  // 否则绝大部分应用及其菜单栏会保持激活。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  // 在macOS上，当单击dock图标并且没有其他窗口打开时，
  // 通常在应用程序中重新创建一个窗口。
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

//设置任务栏快速任务
function SetDockerTasks(){
  app.setUserTasks([]);
}
//注意，快速任务在acrylic window下单独配置
// 您可以把应用程序其他的流程写在在此文件中
// 代码也可以拆分成几个文件，然后用 require 导入。
