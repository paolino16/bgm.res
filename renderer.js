// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

//Electron相关模块
const { app , Menu , Tray, shell, ipcRenderer, nativeTheme,clipboard,nativeImage} = nodeRequire('electron'); //?使用electron
const { dialog } = nodeRequire('@electron/remote')                    //?引入remote.dialog 对话框弹出api
const path = nodeRequire("path");                                     //?引入path
const fs = nodeRequire('fs');                                         //?使用nodejs fs文件操作库
// 额外引入模块
const runtimeUrl = path.join(__dirname, './mpv/mpv.exe');             //?mpv播放核心地址-调试
const packUrl = path.join(process.cwd(), './resources/app.asar.unpacked/mpv/mpv.exe');  //?mpv播放核心地址-打包后
const ffmpegUrl = path.join(process.cwd(), './resources/app.asar.unpacked/mpv');  //?ffmpeg目录-打包后
let exec = nodeRequire('child_process').exec;                         //?引用exec用于CMD指令执行
let mpv = nodeRequire('node-mpv-2');                                  //?引入node-mpv-2接口
let cheerio = nodeRequire('cheerio');                                 //?引入cheerio用于解析html
//初始化存储资源库
const Store = nodeRequire('electron-store');                          //?引入electron-store存储资源库信息
// const store = new Store();                                            //?创建electron-store存储资源库对象-媒体库
let SysdataOption={
  name:"sysdata",//文件名称,默认 config
  fileExtension:"json",//文件后缀,默认json
}; const sysdata = new Store(SysdataOption);                          //?创建electron-store存储资源库对象-系统设置存储

//! NeDB数据库初始化
const appDataPath = process.env.APPDATA || path.join(process.env.HOME, 'Library', 'Application Support'); // 获取appdata
const Datastore = nodeRequire('nedb');
const db = new Datastore({
  filename: path.join(path.join(appDataPath, 'bgm.res'), 'MediaData.db'),
  autoload: false
});
const ElectronStoreAdapter = nodeRequire('./js/legacy-store-adapter.cjs');
const store = new ElectronStoreAdapter();
const RenameBindingBridge = nodeRequire('./js/rename-binding-renderer.cjs');
RenameBindingBridge.install({$,store});
  // 创建自定义适配器实例
//! NeDB数据库初始化OVER

var IfArchivePageIsInit = 0;                                          //?是否已经初始化过Archive页面
var ArchivePageContent_scrollTop = 0;                                 //?Archive页面滚动位置
var ArchivePageContent_scrollTopFreeze = 0;                           //?Archive页面滚动位置-临时变量
var ArchivePageTimelineContentOpened = 0;                             //?Archive页面时间线内容是否打开

ipcRenderer.on('data', (e,arg) => {                                   //?接收主进程传来的数据 
  console.log(arg);
  if(arg.slice(0,18)=='RefreshArchivePage'){
    store.update().then(updatedData => {
    // ArchivePageInit();
    ArchiveMediaDetailsPage(arg.slice(18));
    let RefreshArchivePageTempDataSaver = store.get("WorkSaveNo"+arg.slice(18));
    // *计算作品进度信息
    var RefreshArchiveCardWatchPercent = 0;
    var RefreshArchiveCardWatchPercentBorder='8px';
    for(let Tempi=1;Tempi<=parseInt(RefreshArchivePageTempDataSaver["EPTrueNum"]);Tempi++){
      if(RefreshArchivePageTempDataSaver.EPDetails["EP"+Tempi].Condition=='Watched') RefreshArchiveCardWatchPercent++;
    } RefreshArchiveCardWatchPercent = (RefreshArchiveCardWatchPercent/parseInt(RefreshArchivePageTempDataSaver["EPTrueNum"]))*100
    if(RefreshArchiveCardWatchPercent==100) RefreshArchiveCardWatchPercentBorder='0'
    if(!sysdata.get("Settings.checkboxB.LocalStorageMediaShowProgress")){RefreshArchiveCardWatchPercent = 0} //若禁用进度条，设定长度为0

    var ArchiveCoverPNG = "ArchiveCover.png"; var ArchiveBDMVTag = "none"; //默认关闭BDMV标志
    if (RefreshArchivePageTempDataSaver["BDMV"] == "BDMV") 
      {ArchiveCoverPNG = "ArchiveCoverBDMV.png"; ArchiveBDMVTag = "block"} //BDMV封面

    if(document.getElementById("ArchiveWorkNo"+arg.slice(18)) !== null){
      $("#ArchiveWorkNo"+arg.slice(18)).html(
        "<div class='ArchiveCardThumb' style='background:url(./assets/"+ArchiveCoverPNG+") no-repeat center;background-size:cover;'></div>"+ //封面遮罩阴影
        "<div class='ArchivePageBDMVTag' style='display:"+ArchiveBDMVTag+"'>BDMV</div>"+ //BDMV标志
        "<div id='ArchiveCardProgressShowerNo"+arg.slice(18)+"' class='ArchiveCardProgressShower' style='width:"+RefreshArchiveCardWatchPercent+"%;border-bottom-right-radius: "+RefreshArchiveCardWatchPercentBorder+";background-color:"+SettingsColorPicker(0.8)+";'></div>"+ //进度指示
        "<div class='ArchiveCardTitle'>"+RefreshArchivePageTempDataSaver["Name"]+"</div>"+ //名称
        "<div class='ArchiveCardRateStar'>⭐&nbsp;"+RefreshArchivePageTempDataSaver["Score"]+"</div>"+ //评分
        "<div class='ArchiveCardDirectorYearCorp' style='bottom:22%;left:5%;right:5%;text-align:center;font-style:italic;'>"+
        RefreshArchivePageTempDataSaver["Type"]+"&nbsp;"+RefreshArchivePageTempDataSaver["Eps"]+"话&nbsp;"+RefreshArchivePageTempDataSaver["Year"]+"</div>"+ //资料A
        "<div class='ArchiveCardDirectorYearCorp' style='bottom:12%;left:40%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>原作 "+RefreshArchivePageTempDataSaver["Protocol"]+"</div>"+ //制作原案
        "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:45%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>"+RefreshArchivePageTempDataSaver["Director"]+"</div>"+ //制作监督
        "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:5%;right:50%;text-align:left;color: rgba(255, 255, 255, 0.79);'>"+RefreshArchivePageTempDataSaver["Corp"]+"</div>"+ //制作公司
        "<div style='border-radius: 8px;transition: all 0.5s;left:0%;right:0%;top:0%;bottom:0%;position:absolute;' onclick='ArchiveMediaDetailsPage("+arg.slice(18)+")'></div>") // 点击触发区域
        OKErrorStreamer("OK","媒体数据更新完成！",0);
        document.getElementById("ArchiveWorkNo"+arg.slice(18)).style.background="url(\""+RefreshArchivePageTempDataSaver["Cover"]+"\") no-repeat top";
        document.getElementById("ArchiveWorkNo"+arg.slice(18)).style.backgroundSize="cover";
    }
    else {
      $("#ArchivePageContent").append( "<div id='ArchiveWorkNo"+arg.slice(18)+"' class='ArchiveCardHover' style='background:url(\""+RefreshArchivePageTempDataSaver["Cover"]+"\") no-repeat top;background-size:cover;'>"+
      "<div class='ArchiveCardThumb' style='background:url(./assets/"+ArchiveCoverPNG+") no-repeat center;background-size:cover;'></div>"+ //封面遮罩阴影
      "<div class='ArchivePageBDMVTag' style='display:"+ArchiveBDMVTag+"'>BDMV</div>"+ //BDMV标志
      "<div id='ArchiveCardProgressShowerNo"+arg.slice(18)+"' class='ArchiveCardProgressShower' style='width:"+RefreshArchiveCardWatchPercent+"%;border-bottom-right-radius: "+RefreshArchiveCardWatchPercentBorder+";background-color:"+SettingsColorPicker(0.8)+";'></div>"+ //进度指示
      "<div class='ArchiveCardTitle'>"+RefreshArchivePageTempDataSaver["Name"]+"</div>"+ //名称
      "<div class='ArchiveCardRateStar'>⭐&nbsp;"+RefreshArchivePageTempDataSaver["Score"]+"</div>"+ //评分
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:22%;left:5%;right:5%;text-align:center;font-style:italic;'>"+
      RefreshArchivePageTempDataSaver["Type"]+"&nbsp;"+RefreshArchivePageTempDataSaver["Eps"]+"话&nbsp;"+RefreshArchivePageTempDataSaver["Year"]+"</div>"+ //资料A
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:12%;left:40%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>原作 "+RefreshArchivePageTempDataSaver["Protocol"]+"</div>"+ //制作原案
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:45%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>"+RefreshArchivePageTempDataSaver["Director"]+"</div>"+ //制作监督
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:5%;right:50%;text-align:left;color: rgba(255, 255, 255, 0.79);'>"+RefreshArchivePageTempDataSaver["Corp"]+"</div>"+ //制作公司
      "<div style='border-radius: 8px;transition: all 0.5s;left:0%;right:0%;top:0%;bottom:0%;position:absolute;' onclick='ArchiveMediaDetailsPage("+arg.slice(18)+")'></div>"+ // 点击触发区域
      "<div class='ArchivePageQuickConfig' onclick='ArchiveContentEditer("+arg.slice(18).toString()+");' title='快速编辑'><img src='./assets/menu.png' style='width:80%'></div>"+ //快速编辑
      "</div>" );
      OKErrorStreamer("OK","媒体数据添加完成！",0);
    }
  let archivePageContent = document.getElementById("ArchivePageContent");
  if (archivePageContent) {
    let MediaDetailsBlock = document.getElementById('ArchiveWorkNo'+arg.slice(18));
    archivePageContent.scrollTop = MediaDetailsBlock.offsetTop-20;//archivePageContent.scrollHeight;
  } //将媒体库滚到最底以显示最新添加的作品
  }).catch(err => {
    console.error('更新缓存时出错:', err);
  });
}else if(arg.slice(0,15)=='InitArchivePage'){
  store.update().then(updatedData => {
  console.log("Init without update database");
  document.getElementById('ArchivePageContentDetails').style.marginLeft = '100%';
  document.getElementById('GoBackPage').style.height = '0px';
  setTimeout(function() {document.getElementById('ArchivePageContentDetails').style.display = 'none';document.getElementById('GoBackPage').style.display = 'none';},700);
  document.getElementById('RecentViewEpisodePlayCard').style.display='none';
  document.getElementById('RecentViewEpisodePlayCardBack').style.display='none';
  ArchivePageContent_scrollTopFreeze = ArchivePageContent_scrollTop;
  ArchivePageInit();
  // 滚动到上次位置
  $('#ArchivePageContent').animate({scrollTop: ArchivePageContent_scrollTopFreeze},70)
  }).catch(err => {
    console.error('更新缓存时出错:', err);
  });
  }
});      

//Version Get
// window.onload = function () {
//   var package = nodeRequire("./package.json");
//   document.getElementById("Title").innerText=package.title+" v"+package.version; // Get Version
// }

// function Closer(){ipcRenderer.send('MainWindow','Close');}
// function Hider(){ipcRenderer.send('MainWindow','Hide');}

//引入各子页面初始化模组

// !成功、失败、信息横幅提示调用函数
const { OKErrorStreamer } = nodeRequire('./js/Mainpage_Modules/MainpageToaster.js'); //?引入bgm.res主界面的通知toast函数封装

// TODO MainProgram Load Data Start

// !配置初始化函数
function SysdataDefaultInit(){
  //获取本地json文件的路径
  const SysdataFile_path = path.join(__dirname, './sysdata_default.json').replace(/\\/g, "\/");

  fs.exists(SysdataFile_path, function (exists) {
      if (!exists) {$(".errorInformation").show();return;} 
      else {
        //读取本地的json文件
        let result = JSON.parse(fs.readFileSync(SysdataFile_path));
        sysdata.set(result);
      }
  });
}

// !页面加载完成后初始化数据函数(目前仅初始化主页)
function SysOnload() {
  store.update().then(() => {
  if(!sysdata.get("Settings")){SysdataDefaultInit()}
  if(!sysdata.get("Settings.checkboxC.OOBE")){ipcRenderer.send('OOBEPage','Open')}
  // *Version Get
  var packages = nodeRequire("./package.json");
  document.getElementById("Title").innerText=packages.title+" v"+packages.version; // Get Version
  
  // *Recent View Get <!--格式化HomePage主页继续观看内容-->
  var bgmID = sysdata.get("Settings.checkboxC.LocalStorageRecentViewID");//localStorage.getItem("LocalStorageRecentViewID");
  var MediaID = sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID");//localStorage.getItem("LocalStorageRecentViewLocalID");
  var bgmEP = sysdata.get("Settings.checkboxC.LocalStorageRecentViewEpisode");//localStorage.getItem("LocalStorageRecentViewEpisode");
  if(bgmID != '' && sysdata.get("Settings.checkboxC.LocalStorageRecentViewID")&&sysdata.get("Settings.checkboxC.LocalStorageRecentViewEpisode")){
    $.getJSON("https://api.bgm.tv/v0/subjects/"+bgmID.toString(), function(data){
    document.getElementById("RecentViewDetail").innerText=data.summary;
    document.getElementById("RecentViewName").innerText=data.name;
    document.getElementById("RecentViewTitle").innerText="继续观看: "+data.name_cn;
    document.getElementById("RecentViewRatingScore").innerHTML=
    "<div id='RecentViewRatingRank' class='boxBlank' style='border: 1px dashed rgb(155, 155, 155);background-color: rgba(0, 0, 0, 0.292);top:15%;font-size: 1.5vw;font-family:bgmUI;height: 28%;width:30%;left:10%;backdrop-filter: blur(10px);box-shadow:none;line-height: 200%;'>NO.Null</div>"+
    "<div id='RecentViewRatingPos' class='boxBlank' style='border: 1px dashed rgb(155, 155, 155);background-color: rgba(0, 0, 0, 0.292);bottom:15%;font-size: 1.5vw;font-family:bgmUI;height: 28%;width:30%;left:10%;backdrop-filter: blur(10px);box-shadow:none;line-height: 200%;'>NoRank</div>";
    var HomePageRatingScore =document.createTextNode(data.rating.score.toFixed(1));
    document.getElementById("RecentViewRatingScore").innerText=data.rating.score.toFixed(1);//.appendChild(HomePageRatingScore);
    document.getElementById("RecentViewRatingRank").innerText="NO."+data.rating.rank;
    // 作品等级判定
    if(data.rating.score > 9.5) {document.getElementById("RecentViewRatingPos").innerText="超神作";}
      else if(data.rating.score > 8.5) {document.getElementById("RecentViewRatingPos").innerText="神作";}
      else if(data.rating.score > 7.5) {document.getElementById("RecentViewRatingPos").innerText="力荐";}
      else if(data.rating.score > 6.5) {document.getElementById("RecentViewRatingPos").innerText="推荐";}
      else if(data.rating.score > 5.5) {document.getElementById("RecentViewRatingPos").innerText="还行";}
      else if(data.rating.score > 4.5) {document.getElementById("RecentViewRatingPos").innerText="不过不失";}
      else if(data.rating.score > 3.5) {document.getElementById("RecentViewRatingPos").innerText="较差";}
      else if(data.rating.score > 2.5) {document.getElementById("RecentViewRatingPos").innerText="差";}
      else if(data.rating.score > 1.5) {document.getElementById("RecentViewRatingPos").innerText="很差";}
      else if(data.rating.score >= 1) {document.getElementById("RecentViewRatingPos").innerText="不忍直视";}
      else {document.getElementById("RecentViewRatingPos").innerText="暂无评分";}
    // 作品等级判定OVER
    document.getElementById("HomePage").style.background="url('"+data.images.large+"') no-repeat center";
    if(sysdata.get("Settings.checkboxB.LocalStorageSystemShowModifiedCover")) //判断是否使用自定义背景
    {document.getElementById("HomePage").style.background="url('"+store.find('WorkSaveNo'+MediaID+'.Cover')+"') no-repeat center";}
    document.getElementById("HomePage").style.backgroundSize="cover";
    //错误回调
    }).done(function() { OKErrorStreamer("OK","加载作品信息完成",0); }).fail(function() { document.getElementById("RecentViewTitle").innerText="继续观看: "+store.find("WorkSaveNo"+MediaID+".Name");document.getElementById("RecentViewRatingScore").innerText='0.0'/*.appendChild(document.createTextNode('0.0'))*/;OKErrorStreamer("Error","无法连接Bangumi",0); });
    
    // *EP信息获取
    var RecentViewEpisodeType = sysdata.get("Settings.checkboxC.LocalStorageRecentViewEpisodeType");//localStorage.getItem("LocalStorageRecentViewEpisodeType");
    if(RecentViewEpisodeType!='SP'){
    $.getJSON("https://api.bgm.tv/v0/episodes?subject_id="+bgmID.toString(), function(data1){
      for(var EPTemper=0;EPTemper!=data1.data.length;EPTemper++){
        if(data1.data[EPTemper].hasOwnProperty("ep")&&data1.data[EPTemper].ep==bgmEP) 
        {
          //* 首页自动同步章节看过信息
          if(sysdata.get("UserData.userpageProgressSyncOptions")!='Disabled' && sysdata.get("UserData.EnableTitleProgressUpdate")!=false){$.ajax({url: "https://api.bgm.tv/v0/users/-/collections/-/episodes/"+data1.data[EPTemper].id, //与云端同步章节看过信息
          type: 'GET',contentType: "application/json",headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},timeout : 2000,
          success: function (data2) {if(data2.type!=2){ //判断云端是否观看
            $.ajax({url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID+"/episodes", //当云端未观看时与云端同步章节看过信息
            type: 'PATCH',contentType: "application/json",dataType: "json",
            headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},
            data: '{"episode_id": ['+data1.data[EPTemper].id+'],"type": 2}',timeout : 2000,success: function () {;}, error: function () {;}})
            }
          }, error: function () {;}})}

          $.getJSON("https://api.bgm.tv/v0/episodes/"+data1.data[EPTemper].id, function(data2){document.getElementById("RecentViewProgress").innerText="上次看到: "+"EP"+data2.ep+"-"+data2.name;}).fail(function() {document.getElementById("RecentViewProgress").innerText="上次看到: "+"EP"+bgmEP});break;}
        else{document.getElementById("RecentViewProgress").innerText="上次看到: "+"EP"+bgmEP;}
      }
    // *错误回调
    }).done(function() { OKErrorStreamer("OK","加载作品EP信息完成,数据已同步",0); }).fail(function() {document.getElementById("RecentViewProgress").innerText="上次看到: "+"EP"+bgmEP; OKErrorStreamer("Error","无法连接Bangumi",0); }); // *错误回调
    }
    if(RecentViewEpisodeType=='SP'){
      $.getJSON("https://api.bgm.tv/v0/episodes?subject_id="+bgmID.toString(), function(data1){
        for(let SPTemper=0;SPTemper!=data1.data.length;SPTemper++){
          if(data1.data[SPTemper].type=='1'&&data1.data[SPTemper].sort==bgmEP) 
          {$.getJSON("https://api.bgm.tv/v0/episodes/"+data1.data[SPTemper].id, function(data2){document.getElementById("RecentViewProgress").innerText="上次看到: "+"SP"+data2.type+"-"+data2.name;}).fail(function() {document.getElementById("RecentViewProgress").innerText="上次看到: "+"SP"+bgmEP});break;}
          else{document.getElementById("RecentViewProgress").innerText="上次看到: "+"SP"+bgmEP;}
        }// *错误回调
      }).done(function() { OKErrorStreamer("OK","加载作品SP信息完成",0); }).fail(function() {document.getElementById("RecentViewProgress").innerText="上次看到: "+"SP"+bgmEP; OKErrorStreamer("Error","无法连接Bangumi",0); }); // *错误回调
    }

    $('#RecentViewProgress').attr('onclick',"console.log('OK');RecentViewPlayAction('Last');");

    // *计算作品进度信息
    let RecentViewWatchPercentSaver = 0;
    for(let Tempi=1;Tempi<=parseInt(store.find("WorkSaveNo"+MediaID.toString()+".EPTrueNum"));Tempi++){
      if(store.find("WorkSaveNo"+MediaID.toString()+".EPDetails.EP"+Tempi+'.Condition')=='Watched') RecentViewWatchPercentSaver++;
    } RecentViewWatchPercentSaver = (RecentViewWatchPercentSaver/parseInt(store.find("WorkSaveNo"+MediaID.toString()+".EPTrueNum")))*100
    document.getElementById("RecentViewFullProgressNum").innerText=RecentViewWatchPercentSaver.toFixed(1)+" %";
    document.getElementById("RecentViewFullProgressLine").style.width=RecentViewWatchPercentSaver.toString()+"%";
    if(sysdata.get("Settings.checkboxC.LocalStorageRecentViewEpisodeType")=="EP"&&bgmEP/store.find("WorkSaveNo"+MediaID.toString()+".EPTrueNum")==1) {
      $("#RecentViewPlay").attr('onclick',"ipcRenderer.send('MediaShare',sysdata.get('Settings.checkboxC.LocalStorageRecentViewLocalID'));");
      document.getElementById("RecentViewPlayText").innerText="分享";
      document.getElementById("RecentViewPlayIcon").innerText="";
      document.getElementById("RecentViewPlayIcon").style.background="url(./assets/sharemedia.svg)";
      document.getElementById("RecentViewPlayIcon").style.width="20px";
      document.getElementById("RecentViewPlayIcon").style.height="30px";
    }

    console.log("Success");
  }
  else{
    document.getElementById("RecentViewDetail").innerText="哇啊(＃°Д°)，您最近根本没有本地看过番的说！";
    document.getElementById("RecentViewName").innerText="暂无观看记录";
    document.getElementById("RecentViewTitle").innerText="最近观看";
    document.getElementById("RecentViewRatingScore").innerText="0.0";
    document.getElementById("RecentViewProgress").innerText="您最近没有观看记录！";
  }

  if(sysdata.get("Settings.checkboxB.LocalStorageSystemBackgroundImage")) //判断是否启用自定义背景
  {document.getElementById('HomePage').style.background="url('"+sysdata.get("Settings.checkboxB.LocalStorageSystemBackgroundImage").toString()+"') no-repeat";
  document.getElementById('HomePage').style.backgroundSize='cover';
  document.getElementById('ArchivePage').style.background="url('"+sysdata.get("Settings.checkboxB.LocalStorageSystemBackgroundImage").toString()+"') no-repeat";
  document.getElementById('ArchivePage').style.backgroundSize='cover';
  document.getElementsByClassName('ArchivePageHeader')[0].style.backgroundColor= '#00000058';
  document.getElementById('TorrnetPage').style.background="url('"+sysdata.get("Settings.checkboxB.LocalStorageSystemBackgroundImage").toString()+"') no-repeat";
  document.getElementById('TorrnetPage').style.backgroundSize='cover';
  document.getElementById('SettingsPage').style.background="url('"+sysdata.get("Settings.checkboxB.LocalStorageSystemBackgroundImage").toString()+"') no-repeat";
  document.getElementById('SettingsPage').style.backgroundSize='cover';}
  // *透明效果启用
  if(sysdata.get("Settings.checkboxB.LocalStorageSystemOpenMicaMode")==true){
    document.body.style.background = "#1b1b1b80";
    document.getElementById('HomePage').style.background="#00000000";
    document.getElementById('ArchivePage').style.background="#00000000";
    document.getElementById('TorrnetPage').style.background="#00000000";
    document.getElementById('SettingsPage').style.background="#00000000";}
  
  // *自定义主题色导航栏
  let HomeIconColor = 'rgb(240 145 153)'; // 这是默认的设置图标颜色
  if(sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor")) //判断是否启用自定义主题色
  { HomeIconColor = sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"); // 如果有自定义颜色，就使用自定义颜色
    // document.getElementById("Home").style.border="3px solid "+sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor");
    let CustomColorData = HomeIconColor
    let customcolorstyle=document.createElement('style');//创建一个<style>标签
    let customchangeText=document.createTextNode('.Winui3inputText:focus{border-bottom:2px solid '+CustomColorData+'}')//更改后伪元素的样式
    customcolorstyle.appendChild(customchangeText);//把样式添加到style标签里
    document.body.appendChild(customcolorstyle);//把内联样式表添加到html中  
  }
  document.getElementById("Home").style.color=SettingsColorPicker(1);
  document.getElementById("Home").style.backgroundColor=SettingsColorPicker(0.1);
  // 动态加载 SVG 文件
  $.get('./assets/Home-fill.svg', function(data) { // 将 SVG 内容插入到页面中
    var svg = $(data).find('svg');  $('#HomeIcon').replaceWith(svg);
    $(svg).find('path').attr('fill', HomeIconColor); // 将所有 path 的颜色改为指定颜色
  }, 'xml');
  // *自定义主题色导航栏OVER

  if(sysdata.get("Settings.checkboxA.LocalStorageAutoUpdateArchiveInfo")) //判断是否启用自动更新作品信息
  {ArchiveMediaUpdate();}

  ToggleSimpleHomePage(1) //判断是否初始化简洁首页

  // *动态跟随进度背景图片启用
  if(sysdata.get("Settings.checkboxB.LocalStorageSystemOpenLiveBackground")==true){
    const ffmpeg = nodeRequire('fluent-ffmpeg');
    fs.readdir(ffmpegUrl+"/portable_config/watch_later", function(err, files) {
      if (err || !files) {OKErrorStreamer("Error","因为未曾播放，ffmpeg无法扫描最近播放缓存",0); return console.error('Unable to scan directory: ' + err);}
      // 获取每个文件的创建时间，并找出最新的文件
      let latestFile; let latestTime = 0;
      files.forEach(function(file) {
          const filePath = path.join(ffmpegUrl+"/portable_config/watch_later", file);
          const stat = fs.statSync(filePath);
          if (stat.ctimeMs > latestTime) {latestTime = stat.ctimeMs;latestFile = file;}
      });
      const history_data = fs.readFileSync(ffmpegUrl+'/portable_config/watch_later/'+latestFile, 'UTF-8');
      const lines = history_data.split(/\r?\n/)[0].match(/start=(\d+)\.\d+/);
      ffmpeg.setFfmpegPath(ffmpegUrl+"/ffmpeg.exe");
      ffmpeg(sysdata.get("Settings.checkboxC.LocalStorageRecentViewURL"))
      .screenshots({
        count: 1,
        folder: ffmpegUrl,
        filename: 'screenshot.png',
        timestamps: [lines[1]],
        size: '1920x1080'
      }).on("end",function(){  setTimeout(function(){
        document.getElementById('HomePageLiveBackground').style.background="url('"+ffmpegUrl.replace(/\\/g, "/")+"/screenshot.png?v=" + Date.now()+"') no-repeat";
        document.getElementById('HomePageLiveBackground').style.backgroundSize='cover';
        document.getElementById('HomePageLiveBackground').style.opacity=1;console.log("完成背景更新");
      },500);})
  });
  }
}).catch(err => {
  console.error('更新缓存时出错:', err);});
}window.onload = SysOnload();

// !页面大小变化时更新元素状态函数(目前仅更新作品详情与播放卡片)
window.onresize=function(){  
  if($("#ArchivePageSearchSuggestion").is(":visible")){
    document.getElementById('ArchivePageSearchSuggestion').style.left=document.getElementById("ArchivePageSearch").getBoundingClientRect().left+"px"
    document.getElementById('ArchivePageSearchSuggestion').style.width=document.getElementById("ArchivePageSearch").getBoundingClientRect().width-2+"px"
  }
  if($("#ArchivePageContentDetails").is(":visible")){
    document.getElementById("ArchivePageContentDetailsTitle").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制作品主标题贴左边
    document.getElementById("ArchivePageContentDetailsTitleJp").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制日文标题贴左边
    document.getElementById("ArchivePageContentDetailsTitleJp").style.top=(22+(document.getElementById("ArchivePageContentDetailsTitle").getBoundingClientRect().height)*2/($(window).height())*100).toString()+"%"; // 控制日文标题贴上边
    // document.getElementById("ArchivePageContentDetailsFolderURL").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制打开文件夹按钮贴左边
    // document.getElementById("ArchivePageContentDetailsEditor").style.left=(34+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制作品编辑按钮贴左边
    document.getElementById("ArchivePageContentDetailsBannerButtonContainer").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制作品编辑按钮贴左边

    document.getElementById('RecentViewEpisodePlayCard').style.display='none';document.getElementById('RecentViewEpisodePlayCardBack').style.display='none'; //自动关闭作品播放卡片

    setTimeout(() => {document.getElementById('ArchivePageContentDetailsBlur').style.height=(Math.min(document.getElementById('ArchivePageContentDetails').scrollHeight),(document.getElementById('ArchivePageContentLastCard').offsetTop)).toString()+'px';}, 50);  //控制作品详情模糊背景高度自适应
    ArchiveMediaDetailsAutoPageAction(); //自动重新计算EP页面分页信息
  }
} 

// !页面滚动位置监听
document.getElementById('ArchivePageContent').addEventListener('scroll', (e)=>{
  ArchivePageContent_scrollTop  = e.target.scrollTop  
})

//! 手动存储API(DEV) 
//*输入输入框ID，自动提取输入框内数据并以输入框ID相同键值存入localStorage
function LocalSave(Key,Input){
  if(Key == 13)
  {
    var Inner = document.getElementById(Input.toString()).value;
    localStorage.setItem(Input.toString(),Inner.toString());
    console.log(Inner);
    document.getElementById(Input.toString()).value = "";
    OKErrorStreamer("OK","更改成功保存！",1);
    // document.getElementById(Input.toString()).setAttribute("placeholder","✅更改成功保存！");
    // setTimeout(function() { ipcRenderer.send('MainWindow','Refresh'); }, 1000);
  }
}

// TODO MainPage Relavant Function Start
//! 简洁首页模式切换
function ToggleSimpleHomePage(command = 0){
  if (command == 0){ //切换简洁首页指令
    if (!sysdata.get("Settings.checkboxB.LocalStorageToggleSimpleHomePage")){ //如果未启用简洁首页则打开
      sysdata.set("Settings.checkboxB.LocalStorageToggleSimpleHomePage",true);
      document.getElementById("RecentViewRating").style.display="none";
      document.getElementsByClassName("RecentViewProgressContainer")[0].style.top="78%";
      document.getElementById("RecentViewDetail").style.display="none";
      OKErrorStreamer("OK","已启用简洁首页模式",0);
    } else {  //如果已启用简洁首页则关闭
      sysdata.set("Settings.checkboxB.LocalStorageToggleSimpleHomePage",false);
      document.getElementById("RecentViewRating").style.display="block";
      document.getElementsByClassName("RecentViewProgressContainer")[0].style.top="53%";
      document.getElementById("RecentViewDetail").style.display="block";
      OKErrorStreamer("OK","已关闭简洁首页模式",0);
    }
  } else if (command == 1){ //初始化简洁首页指令
    if (sysdata.get("Settings.checkboxB.LocalStorageToggleSimpleHomePage")){ //启用简洁首页
      document.getElementById("RecentViewRating").style.display="none";
      document.getElementsByClassName("RecentViewProgressContainer")[0].style.top="78%";
      document.getElementById("RecentViewDetail").style.display="none";
    } 
  }
}

//! 胶囊菜单-页面切换
function FloatBarAction(PageID) { //点击切换页面
  if(PageID == "Home"){
    ArchivePageContent_scrollTopFreeze = ArchivePageContent_scrollTop; //记录Archive页面滚动位置
    document.getElementById("HomePage").style.display="block";
    document.getElementById("ArchivePage").style.display="none";
    document.getElementById("TorrnetPage").style.display="none";
    document.getElementById("SettingsPage").style.display="none";

    // *计算作品进度信息
    const RecentViewWatchPercentSaver = nodeRequire("./js/home-progress.cjs").progress(store, sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID"));
    document.getElementById("RecentViewFullProgressNum").innerText=RecentViewWatchPercentSaver.toFixed(1)+" %";
    document.getElementById("RecentViewFullProgressLine").style.width=RecentViewWatchPercentSaver.toString()+"%";

    // *动态跟随进度背景图片启用
    if(sysdata.get("Settings.checkboxB.LocalStorageSystemOpenLiveBackground")==true){
      document.getElementById('HomePageLiveBackground').style.opacity=0;
      const ffmpeg = nodeRequire('fluent-ffmpeg');
      fs.readdir(ffmpegUrl+"/portable_config/watch_later", function(err, files) {
        if (err) {return console.error('Unable to scan directory: ' + err);}
        // 获取每个文件的创建时间，并找出最新的文件
        let latestFile; let latestTime = 0;
        files.forEach(function(file) {
            const filePath = path.join(ffmpegUrl+"/portable_config/watch_later", file);
            const stat = fs.statSync(filePath);
            if (stat.ctimeMs > latestTime) {latestTime = stat.ctimeMs;latestFile = file;}
        });
        const history_data = fs.readFileSync(ffmpegUrl+'/portable_config/watch_later/'+latestFile, 'UTF-8');
        const lines = history_data.split(/\r?\n/)[0].match(/start=(\d+)\.\d+/);
        ffmpeg.setFfmpegPath(ffmpegUrl+"/ffmpeg.exe");
        ffmpeg(sysdata.get("Settings.checkboxC.LocalStorageRecentViewURL"))
        .screenshots({
          count: 1,
          folder: ffmpegUrl,
          filename: 'screenshot.png',
          timestamps: [lines[1]],
          size: '1920x1080'
        }).on("end",function(){
          setTimeout(function(){
          document.getElementById('HomePageLiveBackground').style.background="url('"+ffmpegUrl.replace(/\\/g, "/")+"/screenshot.png?v=" + Date.now()+"') no-repeat";
          document.getElementById('HomePageLiveBackground').style.backgroundSize='cover';
          document.getElementById('HomePageLiveBackground').style.opacity=1;},500);
          console.log("完成背景更新");
        })
      });
    }

    $('#Archive').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Archive.svg', function(data) { $('#ArchiveIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Archive原始图标
    $('#Torrnet').css({'color':'#fff',"background-color": ""});
    $.get('./assets/qbittorrent.svg', function(data) { $('#TorrentIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复torrent原始图标
    $('#Settings').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Settings.svg', function(data) { $('#SettingsIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Settings原始图标

    // document.getElementById("Home").style.border="3px solid rgb(240 145 153)";
    let HomeIconColor = 'rgb(240 145 153)'; // 这是默认的设置图标颜色
    if(sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"))
    { HomeIconColor = sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"); // 如果有自定义颜色，就使用自定义颜色
      //document.getElementById("Home").style.border="3px solid "+sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor");
    }
    // document.getElementById("Archive").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Torrnet").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Settings").style.border="3px solid rgb(66, 66, 66,0)";

    document.getElementById("Home").style.color=SettingsColorPicker(1);
    document.getElementById("Home").style.backgroundColor=SettingsColorPicker(0.1);
    // 动态加载 SVG 文件
    $.get('./assets/Home-fill.svg', function(data) { // 将 SVG 内容插入到页面中
      var svg = $(data).find('svg');  $('#HomeIcon').replaceWith(svg);
      $(svg).find('path').attr('fill', HomeIconColor); // 将所有 path 的颜色改为指定颜色
    }, 'xml');

  }
  else if(PageID == "Archive"){
    document.getElementById("HomePage").style.display="none";
    document.getElementById("ArchivePage").style.display="block";
    document.getElementById("TorrnetPage").style.display="none";
    document.getElementById("SettingsPage").style.display="none";
    if(!IfArchivePageIsInit && sysdata.get("Settings.checkboxC.LocalStorageArchiveTabPos")!='Recent'){ArchivePageInit();IfArchivePageIsInit = true;
      if(sysdata.get("Settings.checkboxA.LocalStorageAutoUpdateArchive")){setTimeout(function(){LocalWorkScanModify()},2000)} //判断是否启用自动更新本地作品信息
      // 滚动到所有作品页
      $("#ArchivePageSwitchTab3").css('background', SettingsColorPicker(0.1));
      $("#ArchivePageSwitchTab3").css('color', SettingsColorPicker(1));
      $("#ArchivePageMainContent").css('transition', '');
      $("#ArchivePageMainContent").css('transform', 'translateX(-50%)');
      setTimeout(function() {$("#ArchivePageMainContent").css('transition', 'transform 0.5s cubic-bezier(0, 1.08, 0.58, 1)');}, 100);
      }//初始化ArchivePage同时记录打开状态
    else if(sysdata.get("Settings.checkboxC.LocalStorageArchiveTabPos")=='Recent') {
      RecentWorksPageInit();
      // 滚动到所有作品页
      $("#ArchivePageSwitchTab1").css('background', SettingsColorPicker(0.1));
      $("#ArchivePageSwitchTab1").css('color', SettingsColorPicker(1));
      $("#ArchivePageSwitchTab2").css({'background': '','color': ''});
      $("#ArchivePageSwitchTab4").css({'background': '','color': ''});
      $("#ArchivePageMainContent").css('transition', '');
      $("#ArchivePageMainContent").css('transform', 'translateX(0%)');
      setTimeout(function() {$("#ArchivePageMainContent").css('transition', 'transform 0.5s cubic-bezier(0, 1.08, 0.58, 1)');}, 100);
    }//初始化RecentViewPage同时记录打开状态

    // document.getElementById("Home").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Archive").style.border="3px solid rgb(240 145 153)";

    $('#Home').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Home.svg', function(data) { $('#HomeIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Home原始图标
    $('#Torrnet').css({'color':'#fff',"background-color": ""});
    $.get('./assets/qbittorrent.svg', function(data) { $('#TorrentIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复torrent原始图标
    $('#Settings').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Settings.svg', function(data) { $('#SettingsIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Settings原始图标

    let ArchiveIconColor = 'rgb(240 145 153)'; // 这是默认的设置图标颜色
    if(sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"))
    { ArchiveIconColor = sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"); // 如果有自定义颜色，就使用自定义颜色
      //document.getElementById("Archive").style.border="3px solid "+sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor");
    }
    // document.getElementById("Torrnet").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Settings").style.border="3px solid rgb(66, 66, 66,0)";

    document.getElementById("Archive").style.color=SettingsColorPicker(1);
    document.getElementById("Archive").style.backgroundColor=SettingsColorPicker(0.1);
    // 动态加载 SVG 文件
    $.get('./assets/Archive-fill.svg', function(data) { // 将 SVG 内容插入到页面中
      var svg = $(data).find('svg');  $('#ArchiveIcon').replaceWith(svg);
      $(svg).find('path').attr('fill', ArchiveIconColor); // 将所有 path 的颜色改为指定颜色
    }, 'xml');

    // 滚动到上次位置
    $('#ArchivePageContent').animate({scrollTop: ArchivePageContent_scrollTopFreeze},70)  
    // document.getElementById('ArchivePageContent').scrollTop = ArchivePageContent_scrollTopFreeze;
  }
  else if(PageID == "Torrnet"){
    ArchivePageContent_scrollTopFreeze = ArchivePageContent_scrollTop; //记录Archive页面滚动位置
    document.getElementById("HomePage").style.display="none";
    document.getElementById("ArchivePage").style.display="none";
    document.getElementById("TorrnetPage").style.display="block";
    document.getElementById("SettingsPage").style.display="none";

    // document.getElementById("Home").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Archive").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Torrnet").style.border="3px solid rgb(240 145 153)";

    $('#Home').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Home.svg', function(data) { $('#HomeIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Home原始图标
    $('#Archive').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Archive.svg', function(data) { $('#ArchiveIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Archive原始图标
    $('#Settings').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Settings.svg', function(data) { $('#SettingsIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Settings原始图标


    let qBitIconColor = 'rgb(240 145 153)'; // 这是默认的设置图标颜色
    if(sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"))
    { qBitIconColor = sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"); // 如果有自定义颜色，就使用自定义颜色
      //document.getElementById("Torrnet").style.border="3px solid "+sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor");
    }
    //document.getElementById("Settings").style.border="3px solid rgb(66, 66, 66,0)";

    document.getElementById("Torrnet").style.color=SettingsColorPicker(1);
    document.getElementById("Torrnet").style.backgroundColor=SettingsColorPicker(0.1);
    // 动态加载 SVG 文件
    $.get('./assets/qbittorrent-fill.svg', function(data) { // 将 SVG 内容插入到页面中
      var svg = $(data).find('svg');  $('#TorrentIcon').replaceWith(svg);
      $(svg).find('path').attr('fill', qBitIconColor); // 将所有 path 的颜色改为指定颜色
    }, 'xml');
  }
  else if(PageID == "Settings"){
    ArchivePageContent_scrollTopFreeze = ArchivePageContent_scrollTop; //记录Archive页面滚动位置
    document.getElementById("HomePage").style.display="none";
    document.getElementById("ArchivePage").style.display="none";
    document.getElementById("TorrnetPage").style.display="none";
    document.getElementById("SettingsPage").style.display="block";

    // document.getElementById("Home").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Archive").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Torrnet").style.border="3px solid rgb(66, 66, 66,0)";
    // document.getElementById("Settings").style.border="3px solid rgb(240 145 153)";
    
    $('#Home').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Home.svg', function(data) { $('#HomeIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Home原始图标
    $('#Archive').css({'color':'#fff',"background-color": ""});
    $.get('./assets/Archive.svg', function(data) { $('#ArchiveIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复Archive原始图标
    $('#Torrnet').css({'color':'#fff',"background-color": ""});
    $.get('./assets/qbittorrent.svg', function(data) { $('#TorrentIcon').replaceWith($(data).find('svg'));}, 'xml'); // 恢复torrent原始图标

    let SettingsIconColor = 'rgb(240 145 153)'; // 这是默认的设置图标颜色
    if(sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"))
    { SettingsIconColor = sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"); // 如果有自定义颜色，就使用自定义颜色
      //document.getElementById("Settings").style.border="3px solid "+sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor");
    }

    document.getElementById("Settings").style.color=SettingsColorPicker(1);
    document.getElementById("Settings").style.backgroundColor=SettingsColorPicker(0.1);
    // 动态加载 SVG 文件
    $.get('./assets/Settings.svg', function(data) { // 将 SVG 内容插入到页面中
      var svg = $(data).find('svg');  $('#SettingsIcon').replaceWith(svg);
      $(svg).find('path').attr('fill', SettingsIconColor); // 将所有 path 的颜色改为指定颜色
    }, 'xml');

    SettingsPageConfigInit()
  }
}

//! 播放-调用MPV播放最近播放 传入Last/Next选择上次播放或者下一话 完成后刷新
function RecentViewPlayAction(Type) {
  if(!sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID")){OKErrorStreamer("Error","暂无观看记录，请从媒体库选择章节",0);return;}
  //获取待播放的最近播放章节类型
  var RecentViewEpisodeType = sysdata.get("Settings.checkboxC.LocalStorageRecentViewEpisodeType");//localStorage.getItem("LocalStorageRecentViewEpisodeType");
  //按继续播放或播放下一话调用url与epid
  if(Type=='Last') {var RecentTempURL = "LocalStorageRecentViewURL";var RecentEP = sysdata.get("Settings.checkboxC.LocalStorageRecentViewEpisode")/*localStorage.getItem("LocalStorageRecentViewEpisode")*/;}
  if(Type=='Next') {var RecentTempURL = "LocalStorageRecentViewNextURL";var RecentEP = Number(sysdata.get("Settings.checkboxC.LocalStorageRecentViewEpisode"))+1;
  store.convertWorkSaveNo("WorkSaveNo"+sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID")).then(currentId => {
  if(RecentViewEpisodeType!='SP'){store.set(currentId+".EPDetails.EP"+(RecentEP-1).toString()+'.Condition','Watched');}
  if(RecentViewEpisodeType=='SP'){store.set(currentId+".SPDetails.SP"+(RecentEP-1).toString()+'.Condition','Watched')}
  }).catch(err => {console.error("查询错误:", err);});
  }
  //当章节为数据库内truenum记录的最后一章时 点击下一话不加载之后的 即使有 而提醒播放完毕
  if(Type=='Next'&&RecentViewEpisodeType!='SP'&&RecentEP>store.find("WorkSaveNo"+sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID")+".EPTrueNum")){setTimeout(function(){OKErrorStreamer("OK","所有EP章节已观看完毕！",0)},1000);SysOnload();return true;}
  if(Type=='Next'&&RecentViewEpisodeType=='SP'&&RecentEP>store.find("WorkSaveNo"+sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID")+".SPTrueNum")){setTimeout(function(){OKErrorStreamer("OK","所有SP章节已观看完毕！",0)},1000);SysOnload();return true;}

  //更新最近观看
  store.recordLastWatched("WorkSaveNo"+sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID"),RecentViewEpisodeType+(RecentEP).toString());
  //如果ArchivePageRecentPlayContent可以找到
  if(document.getElementById("ArchivePageRecentPlayContent")){RecentWorksPageInit()} //刷新最近播放

  
  if(sysdata.get("Settings.checkboxC."+RecentTempURL)){
    var RecentViewURL = sysdata.get("Settings.checkboxC."+RecentTempURL);//localStorage.getItem(RecentTempURL);
    if(sysdata.get("Settings.checkboxA.LocalStorageUseSystemPlayer")){ //使用系统默认播放器
      // 规范化路径，确保兼容性
      DirectvideoPath = path.normalize(RecentViewURL);
      // 构建命令，使用系统默认程序打开文件
      let command = `start "" "${DirectvideoPath}"`;
      // 执行命令，拉起系统应用选择器
      exec(command, (error) => {
          if (error) {
            OKErrorStreamer("Error","无法打开视频文件",0);
          } else {
            var MediaID = sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID");//localStorage.getItem("LocalStorageRecentViewLocalID"); //更新最近播放ep集数与链接信息
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewEpisode",RecentEP);
            localStorage.setItem("LocalStorageRecentViewEpisode",RecentEP);
            if(RecentViewEpisodeType!='SP'){ //根据类型保存播放url
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(RecentEP)+".URL")));
            localStorage.setItem("LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(RecentEP)+".URL")));
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(Number(RecentEP)+1)+".URL")));
            localStorage.setItem("LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(Number(RecentEP)+1)+".URL")));}
            if(RecentViewEpisodeType=='SP'){
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(RecentEP)+".URL")));
            localStorage.setItem("LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(RecentEP)+".URL")));
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(Number(RecentEP)+1)+".URL")));
            localStorage.setItem("LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(Number(RecentEP)+1)+".URL")));}
            SysOnload();
            OKErrorStreamer("OK","开始使用系统播放器播放，已记录进度",0);
          }
      });
    }
    //使用MPV播放器
    else {
    process.noAsar = true; //临时禁用fs对ASAR读取
    fs.access(runtimeUrl, fs.constants.F_OK,function (err) {
      if (err) {  //调试播放核心 
        fs.access(RecentViewURL, fs.constants.F_OK,function (exist) {
          if (exist) { OKErrorStreamer("Error","指定文件不存在！",0); } 
          else {
            process.noAsar = false; //恢复fs对ASAR读取
            var MediaID = sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID");//localStorage.getItem("LocalStorageRecentViewLocalID"); //更新最近播放ep集数与链接信息
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewEpisode",RecentEP);
            localStorage.setItem("LocalStorageRecentViewEpisode",RecentEP);
            if(RecentViewEpisodeType!='SP'){ //根据类型保存播放url
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(RecentEP)+".URL")));
            localStorage.setItem("LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(RecentEP)+".URL")));
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(Number(RecentEP)+1)+".URL")));
            localStorage.setItem("LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(Number(RecentEP)+1)+".URL")));}
            if(RecentViewEpisodeType=='SP'){
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(RecentEP)+".URL")));
            localStorage.setItem("LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(RecentEP)+".URL")));
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(Number(RecentEP)+1)+".URL")));
            localStorage.setItem("LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(Number(RecentEP)+1)+".URL")));}
            SysOnload();
            let mpvPlayer = new mpv({"binary": packUrl,},["--fps=60"]);
            mpvPlayer.start()
            .then(() => {
              mpvPlayer.load(RecentViewURL);// player is running
            })
            // mpvPlayer.load(RecentViewURL);
            }
        });
      } 
      else {  //打包后播放核心 
        fs.access(RecentViewURL, fs.constants.F_OK,function (exist) {
          if (exist) { OKErrorStreamer("Error","指定文件不存在！",0); } 
          else {
            process.noAsar = false; //恢复fs对ASAR读取
            var MediaID = sysdata.get("Settings.checkboxC.LocalStorageRecentViewLocalID");//localStorage.getItem("LocalStorageRecentViewLocalID"); //更新最近播放ep集数与链接信息
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewEpisode",RecentEP);
            localStorage.setItem("LocalStorageRecentViewEpisode",RecentEP);
            if(RecentViewEpisodeType!='SP'){ //根据类型保存播放url
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(RecentEP)+".URL")));
            localStorage.setItem("LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(RecentEP)+".URL")));
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(Number(RecentEP)+1)+".URL")));
            localStorage.setItem("LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".EPDetails.EP"+(Number(RecentEP)+1)+".URL")));}
            if(RecentViewEpisodeType=='SP'){
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(RecentEP)+".URL")));
            localStorage.setItem("LocalStorageRecentViewURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(RecentEP)+".URL")));
            sysdata.set("Settings.checkboxC.LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(Number(RecentEP)+1)+".URL")));
            localStorage.setItem("LocalStorageRecentViewNextURL",RenameBindingBridge.resolveMediaPath(store.find("WorkSaveNo"+MediaID+".URL"),store.find("WorkSaveNo"+MediaID+".SPDetails.SP"+(Number(RecentEP)+1)+".URL")));}
            SysOnload();
            let mpvPlayer = new mpv({"binary": runtimeUrl,},["--fps=60"]);
            mpvPlayer.start()
            .then(() => {
              mpvPlayer.load(RecentViewURL);// player is running
            })
            // mpvPlayer.load(RecentViewURL);
            }
        });
      }
    })
    process.noAsar = false; //恢复fs对ASAR读取
    }
  }
}

// TODO Media Archive Relavant Function Start

//! 媒体库-目录全局扫描模块 媒体库-目录增量扫描模块
const { LocalWorkScan,LocalWorkScanModify } = nodeRequire('./js/Mainpage_Modules/MainpageArchiveScanner.js'); //?引入bgm.res主界面的本地媒体库扫描函数封装

//! 媒体库-页面初始化模块
function ArchivePageInit(){
  OKErrorStreamer("MessageOn","正在加载媒体库",0); //加载提示
  // *Archive Get <!--格式化ArchivePage媒体库内容-->
  let sortListIndex = sysdata.get("Settings.checkboxC.LocalStorageMediaSortType");//获取排序状态
  switch(sortListIndex[0]){
    case 'Name': {$('.ArchivePageMediaSortListContent').eq(3).css({backgroundColor: SettingsColorPicker(0.5)});break;}//名称
    case 'Score': {$('.ArchivePageMediaSortListContent').eq(4).css({backgroundColor: SettingsColorPicker(0.5)});break;} //评分
    case 'Year':  {$('.ArchivePageMediaSortListContent').eq(5).css({backgroundColor: SettingsColorPicker(0.5)});break;} //年份
    case 'Type': {$('.ArchivePageMediaSortListContent').eq(6).css({backgroundColor: SettingsColorPicker(0.5)});break;} //类型
    case 'WorkSaveNo': {$('.ArchivePageMediaSortListContent').eq(7).css({backgroundColor: SettingsColorPicker(0.5)});break;} //默认
  }
  switch(sortListIndex[1]){
    case 'asc': {$('.ArchivePageMediaSortListContent').eq(1).css({backgroundColor: SettingsColorPicker(0.5)});break;}//名称
    case 'desc': {$('.ArchivePageMediaSortListContent').eq(2).css({backgroundColor: SettingsColorPicker(0.5)});break;} //评分
  }

  if(sysdata.get("Settings.checkboxC.LocalStorageMediaBaseNumber")){
    document.getElementById("ArchivePageSum").innerText="共 "+(parseInt(sysdata.get("Settings.checkboxC.LocalStorageMediaBaseNumber"))-parseInt(sysdata.get("Settings.checkboxC.LocalStorageMediaBaseDeleteNumber"))).toString()+" 部作品";}
    var MediaBaseNumberGet = sysdata.get("Settings.checkboxC.LocalStorageMediaBaseNumber");//localStorage.getItem("LocalStorageMediaBaseNumber");
    document.getElementById('ArchivePageContent').innerHTML="";
    if(sysdata.get("Settings.checkboxC.LocalStorageMediaBaseNumber")==0 || !sysdata.get("Settings.checkboxC.LocalStorageMediaBaseNumber"))
    {document.getElementById('ArchivePageContent').innerHTML="<div style='position:absolute;left:25%;right:25%;top:30%;bottom:30%;font-family:bgmUIHeavy;color: rgba(255, 255, 255, 0.5);font-size:3vmin'>暂时没有作品，请前往「设置」选项卡设置正确的媒体库地址后点击右上角菜单中的「全局扫描」按钮来更新媒体库</div>";OKErrorStreamer("MessageOff","正在加载媒体库",0);OKErrorStreamer("Error","暂无媒体！",0);return}
    var MediaBaseScanCounter = 1;
    // requestAnimationFrame(ArchivePageInitCore);
    OKErrorStreamer("MessageOn","正在加载媒体库 0%",0);
    var MediaBaseTempDataSaver = store.get();
    const ArchiveCardMarkup = [];
    ArchivePageInitCore();
    // *扫描作品bgmID获取作品信息
    function ArchivePageInitCore(){
    // for(let MediaBaseScanCounter=1;MediaBaseScanCounter<=MediaBaseNumberGet;MediaBaseScanCounter++){
      if(MediaBaseScanCounter>MediaBaseNumberGet) {document.getElementById("ArchivePageContent").innerHTML=ArchiveCardMarkup.join('');nodeRequire('./js/library-rendering.cjs').mountCovers(document.getElementById("ArchivePageContent"));OKErrorStreamer("MessageOff","媒体库加载完成！",0);OKErrorStreamer("OK","媒体库加载完成！",0);return;}
      if(MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["ExistCondition"] == "Deleted") {;} //发现已删除作品，自动跳过
      else{

      // *计算作品进度信息
      let ArchiveCardWatchPercentSaver = 0;let ArchiveCardWatchPercentRightBorder='4px';let ArchiveCardWatchPercentRightTopBorder = '4px';
      for(let Tempi=1;Tempi<=parseInt(MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["EPTrueNum"]);Tempi++){
        if(MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()].EPDetails["EP"+Tempi].Condition=='Watched') ArchiveCardWatchPercentSaver++;
      } ArchiveCardWatchPercentSaver = (ArchiveCardWatchPercentSaver/parseInt(MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["EPTrueNum"]))*100
      if(ArchiveCardWatchPercentSaver==100) {ArchiveCardWatchPercentRightBorder='0';ArchiveCardWatchPercentRightTopBorder = '8px';}
      if(!sysdata.get("Settings.checkboxB.LocalStorageMediaShowProgress")){ArchiveCardWatchPercentSaver = 0} //若禁用进度条，设定长度为0

      var ArchiveCoverPNG = "ArchiveCover.png"; var ArchiveBDMVTag = "none"; //默认关闭BDMV标志
      if (MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["BDMV"] == "BDMV") 
        {ArchiveCoverPNG = "ArchiveCoverBDMV.png"; ArchiveBDMVTag = "block"} //BDMV封面

      ArchiveCardMarkup.push( "<div id='ArchiveWorkNo"+MediaBaseScanCounter.toString()+"' class='ArchiveCardHover' data-cover='"+nodeRequire('./js/library-rendering.cjs').escapeAttribute(MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Cover"])+"' style='background-color:#292d33;background-repeat:no-repeat;background-position:top;background-size:cover;'>"+
      "<div class='ArchiveCardThumb' style='background:url(./assets/"+ArchiveCoverPNG+") no-repeat center;background-size:cover;'></div>"+ //封面遮罩阴影
      "<div class='ArchivePageBDMVTag' style='display:"+ArchiveBDMVTag+"'>BDMV</div>"+ //BDMV标志
      "<div id='ArchiveCardProgressShowerNo"+MediaBaseScanCounter.toString()+"' class='ArchiveCardProgressShower' style='width:"+ArchiveCardWatchPercentSaver+"%;border-top-right-radius: "+ArchiveCardWatchPercentRightTopBorder+";border-bottom-right-radius: "+ArchiveCardWatchPercentRightBorder+";background-color:"+SettingsColorPicker(0.8)+";'></div>"+ //进度指示
      "<div class='ArchiveCardTitle'>"+MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Name"]+"</div>"+ //名称
      "<div class='ArchiveCardRateStar'>⭐&nbsp;"+MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Score"]+"</div>"+ //评分
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:22%;left:5%;right:5%;text-align:center;font-style:italic;'>"+
      MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Type"]+"&nbsp;"+MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Eps"]+"话&nbsp;"+MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Year"]+"</div>"+ //资料A
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:12%;left:40%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>原作 "+MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Protocol"]+"</div>"+ //制作原案
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:45%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>"+MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Director"]+"</div>"+ //制作监督
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:5%;right:50%;text-align:left;color: rgba(255, 255, 255, 0.79);'>"+MediaBaseTempDataSaver["WorkSaveNo"+MediaBaseScanCounter.toString()]["Corp"]+"</div>"+ //制作公司
      "<div style='border-radius: 8px;transition: all 0.5s;left:0%;right:0%;top:0%;bottom:0%;position:absolute;' onclick='ArchiveMediaDetailsPage("+MediaBaseScanCounter+")'></div>"+ // 点击触发区域
      // "<div class='ArchiveCardDirectorYearCorp' style='font-family:bgmUIHeavy;top:2%;left:45%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);z-index:20;' onclick='ArchiveContentEditer("+MediaBaseScanCounter.toString()+");'>编辑</div>"+ //编辑按键
      "<div class='ArchivePageQuickConfig' onclick='ArchiveContentEditer("+MediaBaseScanCounter.toString()+");' title='快速编辑'><img src='./assets/menu.png' style='width:80%'></div>"+ //快速编辑
      "</div>" );
    }MediaBaseScanCounter+=1;ArchivePageInitCore();//requestAnimationFrame(ArchivePageInitCore);
    // cancelAnimationFrame(ArchivePageInitCore);
  }
}

//! 媒体库-最近播放页面初始化模块
function RecentWorksPageInit(){
  if(store.getRecentWatchedData()){
    OKErrorStreamer("MessageOn","正在加载最近播放列表 0%",0);
    var MediaBaseTempDataSaver = store.getRecentWatchedData();
    var MediaBaseNumberGet = Object.keys(MediaBaseTempDataSaver).length;
    var MediaBaseScanCounter = MediaBaseNumberGet-1;
    document.getElementById('ArchivePageRecentPlayContent').innerHTML="";

    RecentWorksPageInitCore();
    // *扫描作品bgmID获取作品信息
    function RecentWorksPageInitCore(){
      if(MediaBaseScanCounter<0) {OKErrorStreamer("MessageOff","最近播放列表加载完成！",0);return;}
      OKErrorStreamer("MessageOn","正在加载最近播放列表"+parseInt((MediaBaseNumberGet-MediaBaseScanCounter)*100/MediaBaseNumberGet)+"%",0); //加载提示
      let MediaBaseTempDataID = MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"];
      if(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.ExistCondition') == "Deleted") {;} //发现已删除作品，自动跳过
      else{

      var ArchiveCoverPNG = "ArchiveCover.png"; var ArchiveBDMVTag = "none"; //默认关闭BDMV标志
      if (store.find(MediaBaseTempDataID+".BDMV") == "BDMV") 
        {ArchiveCoverPNG = "ArchiveCoverBDMV.png"; ArchiveBDMVTag = "block"} //BDMV封面

      // *计算作品进度信息
      let RecentPlayCardWatchPercent = 0;
      for(let Tempi=1;Tempi<=parseInt(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.EPTrueNum'));Tempi++){
        if(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.EPDetails.EP'+Tempi+".Condition")=='Watched') RecentPlayCardWatchPercent++;
      } 
      RecentPlayCardWatchPercent = (RecentPlayCardWatchPercent/parseInt(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.EPTrueNum')))*100

      $("#ArchivePageRecentPlayContent").append( "<div id='RecentWorkNo"+MediaBaseScanCounter.toString()+"' class='ArchiveCardHover' style='background-color:#44444438'><div class='ArchiveCardHover' style='width:55%;transform:unset;border-top-right-radius: 0px;border-bottom-right-radius: 0px;"+
      "background:url(\""+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Cover')+"\") no-repeat top;background-size:cover;'>"+
      "<div class='ArchiveCardThumb' style='background:url(./assets/"+ArchiveCoverPNG+") no-repeat center;background-size:cover;border-top-right-radius: 0px;border-bottom-right-radius: 0px;'></div>"+ //封面遮罩阴影
      "<div class='ArchivePageBDMVTag' style='display:"+ArchiveBDMVTag+"'>BDMV</div>"+ //BDMV标志
      "<div class='ArchiveCardTitle'>"+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Name')+"</div>"+ //名称
      "<div class='ArchiveCardRateStar'>⭐&nbsp;"+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Score')+"</div>"+ //评分
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:22%;left:5%;right:5%;text-align:center;font-style:italic;'>"+
      store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Type')+"&nbsp;"+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Eps')+"话&nbsp;"+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Year')+"</div>"+ //资料A
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:12%;left:40%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>"+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Protocol')+"</div>"+ //制作原案
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:45%;right:5%;text-align:right;color: rgba(255, 255, 255, 0.79);'>"+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Director')+"</div>"+ //制作监督
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:2%;left:5%;right:50%;text-align:left;color: rgba(255, 255, 255, 0.79);'>"+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.Corp')+"</div>"+ //制作公司
      "<div id='RecentWorkNo"+MediaBaseScanCounter.toString()+"OnClick' style='border-radius: 8px;transition: all 0.5s;left:0%;right:0%;top:0%;bottom:0%;position:absolute;'></div>"+ // 点击触发区域
      "</div>"+
      "<div style='position: absolute;width: 36%;left: 59.7%;bottom: 150px;height: 8px;background: #00000030;border-radius: 4px;'><div class='ArchiveCardProgressShower' style='width:"+RecentPlayCardWatchPercent+"%;border-radius: 4px;background-color:"+SettingsColorPicker(0.8)+";'></div></div>"+ //进度指示
      "<div class='ArchiveCardTitle' style='left: 59.7%;top: 10px;width: 30%;margin: 0;height:auto'>"+MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"]+"</div>"+
      "<div class='ArchiveCardTitle' style='right: 6%;bottom: 147px;text-align:right;margin: 0;height: 25px;font-size: 17px;font-style: italic;color: #0000005c;'>"+parseInt(RecentPlayCardWatchPercent)+"%</div>"+
      "<div id='RecentWorkNo"+MediaBaseScanCounter.toString()+"EPContent' class='ArchiveCardTitle' style='left: 59.7%;top: 50px;width: 36%;margin: 0;font-size: 15px;height:65px;-webkit-line-clamp: 3;'></div>"+
      "<div class='ArchiveCardDirectorYearCorp' style='bottom:110px;left:60%;right:5%;display: flex;align-items: center;justify-content: space-evenly;text-align:center;color: rgba(255, 255, 255, 0.79);'>"+
      "<img src='./assets/ArchivePageTab/recent.svg' style='height:20px;aspect-ratio:1;' />"+store.getTimeDifference(MediaBaseTempDataSaver[MediaBaseScanCounter]["lastWatched"])+"</div>"+ //观看时间
      "<div id='RecentWorkNo"+MediaBaseScanCounter.toString()+"Continue' class='Winui3setTabBrick' style='bottom: 60px;font-family: \"bgmUIHeavy\";background-color: #00000030;position: absolute;left: 59.7%;width: 36%;height: 40px;font-size: 16px;top: unset;'"+
      " ><img src='./assets/play.svg' style='height:25px;aspect-ratio:1;margin-right: 5px;' />继续播放</div>"+
      "<div id='RecentWorkNo"+MediaBaseScanCounter.toString()+"NextEP' class='Winui3setTabBrick' style='bottom: 10px;font-family: \"bgmUIHeavy\";background-color: #00000030;position: absolute;left: 59.7%;width: 36%;height: 40px;font-size: 16px;top: unset;'"+
      " ><img src='./assets/next.svg' style='height:25px;aspect-ratio:1;margin-right: 20px;' />下一话</div>"+
      "</div>" );
      RecentWorksGetEPDetails(MediaBaseScanCounter);
      }MediaBaseScanCounter-=1;RecentWorksPageInitCore();
    }
  } else {OKErrorStreamer("Error","暂无最近播放！",0);}

  function RecentWorksGetEPDetails(MediaBaseScanCounter){

    store.convertWorkSaveNo(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]).then(currentId => {
      $("#RecentWorkNo"+MediaBaseScanCounter.toString()+"OnClick").attr('onclick','ArchiveMediaDetailsPage("'+currentId.split("WorkSaveNo")[1]+'")');

      $("#RecentWorkNo"+MediaBaseScanCounter.toString()+"Continue").attr('onclick','ArchiveMediaDetailsPage("'+currentId.split("WorkSaveNo")[1]+'");setTimeout(function(){ArchiveMediaDetailsEpInfoPlayer('+
      currentId.split("WorkSaveNo")[1]+","+MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"].substring(2)+',"'+MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"].substring(0, 2)+'")},100)');
      if(parseInt(MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"].substring(2))>=parseInt(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.EPTrueNum'))){
      $("#RecentWorkNo"+MediaBaseScanCounter.toString()+"NextEP").attr('onclick','OKErrorStreamer("Error","已经是最后一话了！",0)');
      } else{
      $("#RecentWorkNo"+MediaBaseScanCounter.toString()+"NextEP").attr('onclick','ArchiveMediaDetailsPage("'+currentId.split("WorkSaveNo")[1]+'");setTimeout(function(){ArchiveMediaDetailsEpInfoPlayer('+
      currentId.split("WorkSaveNo")[1]+","+(parseInt(MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"].substring(2))+1)+',"'+MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"].substring(0, 2)+'")},100)');
      }
    }).catch(err => {console.error("查询错误:", err);});
  
    $.getJSON("https://api.bgm.tv/v0/episodes?subject_id="+store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.bgmID'), function(data1){
    for(let EPTemper=0;EPTemper!=data1.data.length;EPTemper++){
      if(data1.data[EPTemper].hasOwnProperty("ep")&&data1.data[EPTemper].ep==MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"].substring(2)) 
      {$.getJSON("https://api.bgm.tv/v0/episodes/"+data1.data[EPTemper].id, function(data2){
        $("#RecentWorkNo"+MediaBaseScanCounter.toString()+"EPContent").html(data2.name+"<br>"+data2.name_cn);
      }).fail(function() {$("#RecentWorkNo"+MediaBaseScanCounter.toString()+"EPContent").html(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.EPDetails.'+MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"]+".URL"));});break;}
      else{$("#RecentWorkNo"+MediaBaseScanCounter.toString()+"EPContent").html(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.EPDetails.'+MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"]+".URL"));}
    }}).fail(function() {$("#RecentWorkNo"+MediaBaseScanCounter.toString()+"EPContent").html(store.find(MediaBaseTempDataSaver[MediaBaseScanCounter]["workID"]+'.EPDetails.'+MediaBaseTempDataSaver[MediaBaseScanCounter]["episode"]+".URL"));}); // *错误回调
  }
}

//! 媒体库-页面切换模块
function ArchivePageSwitch(PageID){

  for(let temp1 = 1;temp1!=5;temp1++) 
    {
      if (temp1==PageID) {$("#ArchivePageSwitchTab"+String(temp1)).css('background', SettingsColorPicker(0.1));
      $("#ArchivePageSwitchTab"+String(temp1)).css('color', SettingsColorPicker(1)) 
    } 
      else {$("#ArchivePageSwitchTab"+String(temp1)).css('background', '');$("#ArchivePageSwitchTab"+String(temp1)).css('color','aliceblue')}
    }
  switch(PageID){
    case 1:{$("#ArchivePageMainContent").css('transform', 'translateX(0%)');RecentWorksPageInit();sysdata.set("Settings.checkboxC.LocalStorageArchiveTabPos","Recent");break;}
    case 2:$("#ArchivePageMainContent").css('transform', 'translateX(-25%)');break;
    case 3:{$("#ArchivePageMainContent").css('transform', 'translateX(-50%)');sysdata.set("Settings.checkboxC.LocalStorageArchiveTabPos","Archive");if(!IfArchivePageIsInit){ArchivePageInit();IfArchivePageIsInit = true;}break;}
    case 4:$("#ArchivePageMainContent").css('transform', 'translateX(-75%)');break;
  }
  if(PageID==4&&ArchivePageTimelineContentOpened==0) {
    $.ajax({ //获取用户信息
      url: "https://api.bgm.tv/calendar",type: 'GET',timeout : 2000,
      success: function (data) {
        var Weekdays = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
        for (let temp1 = 0; temp1 < 7; temp1++) {
          for (let temp2 = 0; temp2 < data[temp1]["items"].length; temp2++) {
            if(temp1==0 || temp1==6){ //周末周一的2号占位卡片填充，使用户永远可以看到任意日期前后的时间线
              $('#ArchivePageTimelineContent'+Weekdays[temp1]+'2Ani').append( "<div class='ArchiveCardCharacterHover'style='height: 100%;margin: 0;margin-right: 20px;flex:unset'"+
                "onclick=\"\""+"><div style='position:relative;left:0%;top:0%;height:100%;aspect-ratio:1;background:url(\""+data[temp1]["items"][temp2]["images"]["large"]+"\") no-repeat top;background-size:cover;border-radius:8px;border-top-right-radius:0;border-bottom-right-radius:0;'></div>"+
                "<div style='position:relative;margin-right:0%;margin-left:1%;margin-top:8px;height:100%;border-radius:8px;width: 100%;text-align: left;width:fit-content;padding:10px;padding-right:20px;white-space:nowrap;font-size:14.5px;'>"+
                "<b>"+data[temp1]["items"][temp2]["name"]+"<br>"+data[temp1]["items"][temp2]["name_cn"]+"</b><br>On Air: "+data[temp1]["items"][temp2]["air_date"]+"</div></div>")
            }
            $('#ArchivePageTimelineContent'+Weekdays[temp1]+'Ani').append( "<div class='ArchiveCardCharacterHover'style='height: 100%;margin: 0;margin-right: 20px;flex:unset'"+
              "onclick=\"shell.openExternal('"+data[temp1]["items"][temp2]["url"]+"');\""+"><div style='position:relative;left:0%;top:0%;height:100%;aspect-ratio:1;background:url(\""+data[temp1]["items"][temp2]["images"]["large"]+"\") no-repeat top;background-size:cover;border-radius:8px;border-top-right-radius:0;border-bottom-right-radius:0;'></div>"+
              "<div style='position:relative;margin-right:0%;margin-left:1%;margin-top:8px;height:100%;border-radius:8px;width: 100%;text-align: left;width:fit-content;padding:10px;padding-right:20px;white-space:nowrap;font-size:14.5px;'>"+
              "<b>"+data[temp1]["items"][temp2]["name"]+"<br>"+data[temp1]["items"][temp2]["name_cn"]+"</b><br>On Air: "+data[temp1]["items"][temp2]["air_date"]+"</div></div>")
          }
        }
        //获取今天星期
        var WeekToday = new Date().getDay();
        setTimeout(function(){ //延迟加载，等待动画完成
        if(WeekToday==0) WeekToday=7; //修正星期天为7
        let AnimateTargetTimelineContent = document.getElementById('ArchivePageTimelineContent'+Weekdays[WeekToday-1]).offsetTop-130;
        $('#ArchivePageTimelineContent').animate({scrollTop: AnimateTargetTimelineContent},600) //滚动到当前星期
        $('#ArchivePageTimelineContent'+Weekdays[WeekToday-1]).css({'transform':'scale(1.06) translateX(3%)',
          'color': SettingsColorPicker(1),
          'background': SettingsColorPicker(0.1) });
        // 动态加载 SVG 文件
        $.get('./assets/calendar.svg', function(data) { // 将 SVG 内容插入到页面中
          var svg = $(data).find('svg');  $('#ArchivePageTimelineContentIcon'+Weekdays[WeekToday-1]).replaceWith(svg);
          $(svg).find('path').attr('fill', SettingsColorPicker(1)); // 将所有 path 的颜色改为指定颜色
        }, 'xml');
        }, 1000);
        ArchivePageTimelineContentOpened = 1;
      }

    });
  };
}

//! 媒体库-计算作品进度信息
function ArchivePageMediaProgressCalc(MediaID){
    // *计算作品进度信息
    var ArchiveCardWatchPercentSaver = 0;var ArchiveCardWatchPercentRightBorder='8px'
    for(let Tempi=1;Tempi<=parseInt(store.get("WorkSaveNo"+MediaID.toString()+".EPTrueNum"));Tempi++){
      if(store.get("WorkSaveNo"+MediaID.toString()+".EPDetails.EP"+Tempi+'.Condition')=='Watched') ArchiveCardWatchPercentSaver++;
    } ArchiveCardWatchPercentSaver = (ArchiveCardWatchPercentSaver/parseInt(store.get("WorkSaveNo"+MediaID.toString()+".EPTrueNum")))*100
    if(ArchiveCardWatchPercentSaver==100) ArchiveCardWatchPercentRightBorder='0'
    if(document.getElementById("ArchiveCardProgressShowerNo"+MediaID.toString())){
    document.getElementById("ArchiveCardProgressShowerNo"+MediaID.toString()).style.width=ArchiveCardWatchPercentSaver+"%";
    document.getElementById("ArchiveCardProgressShowerNo"+MediaID.toString()).style.borderBottomRightRadius=ArchiveCardWatchPercentRightBorder;}
}

//! 媒体库-搜索模块
const { ArchivePageMediaSearch } = nodeRequire('./js/Mainpage_Modules/MainpageArchiveSearch.js'); //?引入bgm.res主界面的本地媒体库搜索函数封装

//! 媒体库-作品设置模块 媒体库-作品设置-存储API 媒体库作品设置-作品删除
const { ArchiveContentEditer,StoreSave,StoreDeleteWork } = nodeRequire('./js/Mainpage_Modules/MainpageArchiveSettings.js'); //?引入bgm.res主界面的本地媒体库设置函数封装

//! 媒体库-作品数据信息链接BGM更新模块(所有作品) 媒体库-作品数据信息链接BGM更新模块(指定作品ID范围) 
const { ArchiveMediaUpdate,ArchiveMediaUpdateSingle } = nodeRequire('./js/Mainpage_Modules/MainpageArchiveInfUpdate.js'); //?引入bgm.res主界面的本地媒体库信息更新函数封装

//! 媒体库-新增作品模块
const { LocalWorkManualAddAndSave } = nodeRequire('./js/Mainpage_Modules/MainpageArchiveAdder.js'); //?引入bgm.res主界面的本地媒体库新增作品函数封装

// TODO Media Archive Details Relavant Function Start

/* 媒体库详情页面初始化系统 */
function ArchiveMediaDetailsPage(MediaID){
  var bgmID = store.get("WorkSaveNo"+MediaID+".bgmID");
  nodeRequire('./js/subject-relations.cjs').load({$,document,store,subjectId:bgmID,openLocal:ArchiveMediaDetailsPage,openExternal:url=>shell.openExternal(url),color:SettingsColorPicker});
  document.getElementById("ArchivePageContentDetailsTitleBlock").innerHTML=""; //清空TitleBlock
  document.getElementById("ArchivePageContentDetailsEpisodeBlock").innerHTML=""; //清空EpisodeBlock
  document.getElementById("ArchivePageContentDetailsSpecialEpisodeBlock").innerHTML=""; //清空SpecialEpisodeBlock
  document.getElementById("ArchivePageContentDetailsEpisodeExtraBlock").innerHTML=""; //清空EpisodeExtraBlock
  
  //?填充BDMV标志
  var ArchiveInfoCoverPNG = "display:none"; var ArchiveInfoBDMVTag = "none"; //默认关闭BDMV标志
  document.getElementById("ArchivePageContentDetailsEpisodeBlockContainer").style.display = "block"; //显示章节详情
  document.getElementById("ArchivePageContentDetailsBDMVBanner").style.display = "none"; //默认屏蔽BDMV横幅
  if (store.get("WorkSaveNo"+MediaID+".BDMV") == "BDMV") {
    ArchiveInfoCoverPNG = "background:url(./assets/ArchiveInfoBDMV.png) no-repeat center;background-size:cover;opacity:1"; 
    document.getElementById("ArchivePageContentDetailsEpisodeBlockContainer").style.display = "none"; //对于BDMV屏蔽章节详情
    document.getElementById("ArchivePageContentDetailsBDMVBanner").style.display = "flex"; //显示BDMV横幅
    ArchiveInfoBDMVTag = "block";} //BDMV封面

  //?填充标题&评分条UI
  $("#ArchivePageContentDetailsTitleBlock").append(
    "<div id='ArchivePageContentDetailsCover' class='ArchiveCardHover' style='position:absolute;top:7%;height:86%;left:17%;width:auto;aspect-ratio:3/4;margin:2%' onclick='shell.openExternal(\"https://bgm.tv/subject/"+store.get("WorkSaveNo"+MediaID+".bgmID")+"\");'><div class='ArchiveCardThumb' style='"+ArchiveInfoCoverPNG+"'></div></div>"+
    "<div id='ArchivePageContentDetailsTitle' class='RecentViewName' style='height:auto;top:15%;font-size:min(3vw, 45px);right:max(25%, 270px);overflow: hidden;display: -webkit-box; text-overflow: ellipsis; -webkit-box-orient: vertical;-webkit-line-clamp: 2;   '>未知作品</div>"+
    "<div id='ArchivePageContentDetailsTitleJp' class='RecentViewName' style='height:auto;top:15%;font-size:min(1.5vw,30px);right:max(25%, 270px);overflow: hidden;display: -webkit-box; text-overflow: ellipsis; -webkit-box-orient: vertical;-webkit-line-clamp: 2;   '>不明な作品</div>"+
    "<div id='ArchivePageContentDetailsBannerButtonContainer' style='position: absolute;width: 30%;height: auto;left: 38.5787%;top: 80%;bottom: 0%;max-width: 500px;display: flex;align-content: stretch;align-items: stretch;flex-direction: row;'>"+
      "<div id='ArchivePageContentDetailsFolderURL' class='ArchivePageButton' style='position:relative;top:80%;bottom:0%;height:auto;font-size:2.3vmin;-webkit-app-region:unset;border-top-right-radius: 0px; border-bottom-right-radius: 0px;border:unset;top: 0%;width: 40%;bottom: 0%;height: auto;backdrop-filter: none;' onclick=\"exec('explorer "+store.get("WorkSaveNo"+MediaID+".URL").replace(/(\\)/g,"\\\\").replace(/(&)/g,"^&").replace(/(')/g,'\\\'')+"');\"><img src='./assets/folder.svg' alt='folder' height=45% style='margin-right:5px;'/>打开文件夹</div>"+
      "<div id='ArchivePageContentDetailsEditor' class='ArchivePageButton' style='position:relative;top:80%;width:3%;bottom:0%;height:auto;font-size:2.3vmin;-webkit-app-region:unset;border-top-left-radius: 0px; border-bottom-left-radius: 0px;border:unset;top: 0%;width: 11%;bottom: 0%;height: auto;backdrop-filter: none;' onclick='ArchiveContentEditer("+MediaID.toString()+");'><img src='./assets/edit.svg' alt='edit' height=40% style='margin:5px;'/></div>"+
    "</div>"+
    
    //评分系统
    "<div id='ArchivePageContentDetailsRating' class='RecentViewRating' style='padding:0;height:95%;max-width: 300px;min-width: 220px;'>"+
    "<div id='ArchivePageContentDetailsRatingScorePrevious' style='position:relative;right:0%;width:100%;font-size: 8vmin;font-family:bgmUIHeavy;text-align: right;'>"+
    "<div id='ArchivePageContentDetailsRatingRank' class='boxBlank' style='/*border: 1px dashed rgb(155, 155, 155);*/background-color: rgba(0, 0, 0, 0.292);top:15%;font-size: 1.9vmin;font-family:bgmUI;height: 25%;width:32%;left:4%;backdrop-filter: blur(10px);box-shadow:none;display: flex;justify-content: center;align-items: center;'>NO.Null</div>"+
    "<div id='ArchivePageContentDetailsRatingPos' class='boxBlank' style='/*border: 1px dashed rgb(155, 155, 155);*/background-color: rgba(0, 0, 0, 0.292);bottom:20%;font-size: 2vmin;font-family:bgmUI;height: 25%;width:32%;left:4%;backdrop-filter: blur(10px);box-shadow:none;display: flex;justify-content: center;align-items: center;'>NoRank</div>"+
    "<div id='ArchivePageContentDetailsRatingScore'>0.0</div></div>"+"<div style='position:relative;height:40%;width:100%;bottom:0%;margin-top:14%'>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo10' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>10</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo9' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>9</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo8' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>8</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo7' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>7</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo6' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>6</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo5' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>5</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo4' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>4</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo3' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>3</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo2' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>2</div></div>"+
    "<div class='LoadScoreBar'><div class='ScoreBar' id='ArchivePageContentDetailsScoreBarNo1' style='height:30%'></div><div style='position:absolute;bottom: -25%;font-size: 2vmin;text-align: center;width: 100%;'>1</div></div>"+
    "</div><div id='ArchivePageContentDetailsScoreRatePeople' style='position:relative;margin-top:-1%;width:95%;height:10%;left:10px;text-align:none;color:rgb(172, 172, 172);font-size:2.1vmin'></div></div>"
  );

  //?填充评分&标准差&检测是否为当季新番
  $.getJSON("https://api.bgm.tv/v0/subjects/"+bgmID.toString(), function(data){
    document.getElementById('ArchivePageContentDetailsTitleJp').innerText=data.name || '';
    document.getElementById("ArchivePageContentDetailsRatingScore").innerText=data.rating.score.toFixed(1);//.appendChild(ArchivePageContentDetailsRatingScore);
    store.set("WorkSaveNo"+MediaID.toString()+".Score",data.rating.score); 
    $("#ArchivePageContentDetailsRatingScore").append("<div style='font-size:2vmin;margin-top: -10px;font-weight: normal;color: rgb(172, 172, 172);text-decoration: underline;font-family: bgmUI;' onclick=\"window.open('https://netaba.re/subject/"+bgmID.toString()+"')\">查看趋势</div>");
    $("#ArchivePageContentDetailsRatingScore").append("<div style='font-size:2vmin;margin-top: -3vmin;margin-right:8.5vmin;font-weight: normal;color: rgb(172, 172, 172);text-decoration: underline;font-family: bgmUI;' onclick=\"window.open('https://bgm.tv/subject/"+bgmID.toString()+"/stats')\">查看透视</div>");
    if(!sysdata.get("Settings.checkboxB.LocalStorageMediaShowSciMark")){document.getElementById("ArchivePageContentDetailsRatingRank").innerText="NO."+data.rating.rank;} //判断是否启用科学排名，关闭源站排名
    // 作品等级判定
    if(data.rating.score > 9.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="超神作";}
      else if(data.rating.score > 8.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="神作";}
      else if(data.rating.score > 7.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="力荐";}
      else if(data.rating.score > 6.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="推荐";}
      else if(data.rating.score > 5.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="还行";}
      else if(data.rating.score > 4.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="不过不失";}
      else if(data.rating.score > 3.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="较差";}
      else if(data.rating.score > 2.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="差";}
      else if(data.rating.score > 1.5) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="很差";}
      else if(data.rating.score >= 1) {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="不忍直视";}
      else {document.getElementById("ArchivePageContentDetailsRatingPos").innerText="暂无评分";}
    // 作品等级判定OVER
    // 填充一分一段表，打分信息
    var ScoreAverage = 0;var ScoreSD = 0;
    for(let Tempi = 1;Tempi<=10;Tempi++){
      document.getElementById('ArchivePageContentDetailsScoreBarNo'+Tempi.toString()).style.height=((data.rating.count[Tempi]/data.rating.total)*100).toString()+'%'
      ScoreAverage+=Tempi*data.rating.count[Tempi];
    }document.getElementById('ArchivePageContentDetailsScoreRatePeople').innerText=data.collection.wish+'想看/'+data.collection.collect+'看过/'+data.collection.doing+'在看/'+data.collection.on_hold+'搁置/'+data.collection.dropped+'抛弃'
    
    // 检查是否为当季新番
    document.getElementById('ArchivePageContentDetailsAutoEPBanner').style.display='none';
    let CurrMonth = new Date().getMonth()+1;
    let CurrYear = new Date().getFullYear();
    if (data.date == null) data.date = "1368-01-23";
    let CurrSeason = Math.floor( (CurrMonth%3 == 0 ? (CurrMonth/3):(CurrMonth/3 + 1) ) )
    let AnimeSeason = Math.floor( (parseInt(data.date.substr(5,2))%3 == 0 ? (parseInt(data.date.substr(5,2))/3):(parseInt(data.date.substr(5,2))/3 + 1) ) )
    if(CurrSeason == AnimeSeason && parseInt(CurrYear) == parseInt(data.date.substr(0,4)))
    {
      document.getElementById('ArchivePageContentDetailsAutoEPBanner').style.display='flex';
      store.set("WorkSaveNo"+MediaID+".EPAutoUpdate",true);
    }

    //计算标准差
    if(sysdata.get("Settings.checkboxB.LocalStorageMediaShowStd")){ //判断是否显示标准差
    ScoreAverage/=data.rating.total;
    for(let Tempi = 1;Tempi<=10;Tempi++){ScoreSD+=data.rating.count[Tempi]*(Tempi-ScoreAverage)*(Tempi-ScoreAverage);}
    ScoreSD/=data.rating.total;ScoreSD=Math.sqrt(ScoreSD);
    $("#ArchivePageContentDetailsRatingScore").append("<div style='font-size:2vmin;margin-top: -0vmin;margin-right:0vmin;font-weight: normal;color: rgb(172, 172, 172);font-family: bgmUI;')\">标准差:"+ScoreSD.toFixed(2)+"</div>");
    //标准差过高提醒
    if(ScoreSD>2){document.getElementById('ArchivePageContentDetailsRatingScore').style.color='rgb(255 73 91)';document.getElementById('ArchivePageContentDetailsRating').title='注意：此作品的评分参考度低'}
    }
    //错误回调
    }).done(function() { OKErrorStreamer("OK","加载作品信息完成",0); }).fail(function() { document.getElementById("ArchivePageContentDetailsRatingScore").innerText=('0.0'/*document.createTextNode('0.0')*/);OKErrorStreamer("Error","无法连接Bangumi",0); });
    
  //?填充EP选集列表
  if (sysdata.get("Settings.checkboxA.LocalStorageAutoUpdateMediaInfo")==true || store.get("WorkSaveNo"+MediaID+".EPAutoUpdate")==true) //判断是否自动更新EP信息
  {
    OKErrorStreamer("MessageOn","<div class='LoadingCircle'>正在更新EP信息，请稍后</div>",0);
    setTimeout(function(){
      LocalWorkEpsScanModule(MediaID);
      // for(let TempCounter = 1;TempCounter<=store.get("WorkSaveNo"+MediaID+".EPTrueNum");TempCounter++){
      //   $("#ArchivePageContentDetailsEpisodeBlock").append( "<div id='ArchivePageContentDetailsEpisodeNo"+TempCounter+"' class='ArchiveCardHover' "+
      //   "style='width:100%;height:100%;padding:0px;font-family: bgmUIHeavy;font-size:25px;text-align:center;display:flex;justify-content:center;align-items:center;transition:all 0.3s cubic-bezier(0,0,0.2,1);box-shadow:0px 0px 0px 0px #ffffff4a;background-color:rgb(0,0,0,0.3);/*backdrop-filter: blur(30px)*/' onclick='ArchiveMediaDetailsEpInfoCard(event,"+MediaID+","+TempCounter+",\"EP\");'>"+"EP "+TempCounter+"</div>" );
      //   //width:12.1%;height:4vw;padding:2px;
      //   //检测是否已播放过
      //   if(store.get("WorkSaveNo"+MediaID+".EPDetails.EP"+TempCounter+'.Condition')=='Watched'){
      //     document.getElementById('ArchivePageContentDetailsEpisodeNo'+TempCounter).style.backgroundColor=SettingsColorPicker(0.4);
      //     document.getElementById('ArchivePageContentDetailsEpisodeNo'+TempCounter).style.boxShadow='0px 0px 0px 2px '+SettingsColorPicker(0.4)} //' rgb(240 145 153)'
      // } 
      ArchiveMediaDetailsAutoPageEpisodes(MediaID); //更新EP信息
      ArchivePageMediaProgressCalc(MediaID);OKErrorStreamer("MessageOff","<div class='LoadingCircle'></div>",0);OKErrorStreamer("OK","已更新EP信息",0);//刷新外部进度条
    },5);//更新EP信息
  }
  else{
    // for(let TempCounter = 1;TempCounter<=store.get("WorkSaveNo"+MediaID+".EPTrueNum");TempCounter++){
    //   $("#ArchivePageContentDetailsEpisodeBlock").append( "<div id='ArchivePageContentDetailsEpisodeNo"+TempCounter+"' class='ArchiveCardHover' "+
    //   "style='width:100%;height:100%;padding:0px;font-family: bgmUIHeavy;font-size:25px;text-align:center;display:flex;justify-content:center;align-items:center;transition:all 0.3s cubic-bezier(0,0,0.2,1);box-shadow:0px 0px 0px 0px #ffffff4a;background-color:rgb(0,0,0,0.3);/*backdrop-filter: blur(30px)*/' onclick='ArchiveMediaDetailsEpInfoCard(event,"+MediaID+","+TempCounter+",\"EP\");'>"+"EP "+TempCounter+"</div>" );
    //   //width:12.1%;height:4vw;padding:2px;
    //   //检测是否已播放过
    //   if(store.get("WorkSaveNo"+MediaID+".EPDetails.EP"+TempCounter+'.Condition')=='Watched'){
    //     document.getElementById('ArchivePageContentDetailsEpisodeNo'+TempCounter).style.backgroundColor=SettingsColorPicker(0.4);
    //     document.getElementById('ArchivePageContentDetailsEpisodeNo'+TempCounter).style.boxShadow='0px 0px 0px 2px '+SettingsColorPicker(0.4)} //' rgb(240 145 153)'
    // } 
    ArchiveMediaDetailsAutoPageEpisodes(MediaID); //更新EP信息
  }
  //?填充SP选集列表
  if(!store.get("WorkSaveNo"+MediaID+".SPTrueNum") || store.get("WorkSaveNo"+MediaID+".SPTrueNum")==0){document.getElementById('ArchivePageContentDetailsSpecialEpisodeBlock').style.display='none';} //若没有SP就不显示
  else {document.getElementById('ArchivePageContentDetailsSpecialEpisodeBlock').style.display='grid';}
  for(let TempCounter = 1;TempCounter<=store.get("WorkSaveNo"+MediaID+".SPTrueNum");TempCounter++){
    $("#ArchivePageContentDetailsSpecialEpisodeBlock").append( "<div id='ArchivePageContentDetailsSpecialEpisodeNo"+TempCounter+"' class='ArchiveCardHover' "+
    "style='width:100%;height:100%;padding:0px;font-family: bgmUIHeavy;font-size:25px;text-align:center;display:flex;justify-content:center;align-items:center;transition:all 0.3s cubic-bezier(0,0,0.2,1);box-shadow:0px 0px 0px 0px #ffffff4a;background-color:rgb(0,0,0,0.3);/*backdrop-filter: blur(30px)*/' onclick='ArchiveMediaDetailsEpInfoCard(event,"+MediaID+","+TempCounter+",\"SP\");'>"+"SP "+(store.get("WorkSaveNo"+MediaID+".SPDetails.SP"+TempCounter+".EpisodeNumber") || TempCounter)+"</div>" );
    //width:12.1%;height:4vw;padding:2px;
    //检测是否已播放过
    if(store.get("WorkSaveNo"+MediaID+".SPDetails.SP"+TempCounter+'.Condition')=='Watched'){
      document.getElementById('ArchivePageContentDetailsSpecialEpisodeNo'+TempCounter).style.backgroundColor=SettingsColorPicker(0.4);
      document.getElementById('ArchivePageContentDetailsSpecialEpisodeNo'+TempCounter).style.boxShadow='0px 0px 0px 2px '+SettingsColorPicker(0.4)} //' rgb(240 145 153)'
  } 

  //?播放进度同步至本地
  if(sysdata.get("UserData.userpageProgressSyncOptions")=='Cloud'||sysdata.get("UserData.userpageProgressSyncOptions")=='Mix'){
    $.ajax({ //获取用户信息
      url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID.toString()+"/episodes?offset=0&episode_type=0",type: 'GET',headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},timeout : 2000,
      success:function(data){let SyncEPNum=null;  if (parseInt(store.get("WorkSaveNo"+MediaID+".EPTrueNum"))>parseInt(store.get("WorkSaveNo"+MediaID+".Eps"))) {SyncEPNum = store.get("WorkSaveNo"+MediaID+".Eps");} 
      else {SyncEPNum = store.get("WorkSaveNo"+MediaID+".EPTrueNum");}
      console.log("总数"+SyncEPNum)
      $.ajax({ //获取用户信息
        url: "https://api.bgm.tv/v0/me",type: 'GET',headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},timeout : 2000,
        success: function (data2) {
        $.ajax({ //获取收藏信息
          url: "https://api.bgm.tv/v0/users/"+data2.username+"/collections/"+bgmID,type: 'GET',dataType: "json",headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},timeout : 2000,
          success: function () {
            console.log("收藏的作品-拉取云端");
            if(1){ //如果未收藏，不继续尝试同步
            for(let tempii = 1;tempii<=SyncEPNum;tempii++){
              if(data.data[tempii-1].type==2){
                store.set("WorkSaveNo"+MediaID+".EPDetails.EP"+tempii+'.Condition',"Watched")
                document.getElementById('ArchivePageContentDetailsEpisodeNo'+tempii).style.backgroundColor=SettingsColorPicker(0.4); //' rgb(240 145 153)'
                document.getElementById('ArchivePageContentDetailsEpisodeNo'+tempii).style.boxShadow='0px 0px 0px 2px '+SettingsColorPicker(1)} //' rgb(240 145 153)'
              if(data.data[tempii-1].type==0&&sysdata.get("UserData.userpageProgressSyncOptions")=='Cloud'){
                store.set("WorkSaveNo"+MediaID+".EPDetails.EP"+tempii+'.Condition',"Unwatched")}
            }
            if(sysdata.get("UserData.userpageProgressSyncOptions")=='Mix'){
              let SyncContentWatched = null; //Mix同步观看的动画剧集
              for(let tempi = 1;tempi<=SyncEPNum;tempi++)
                {if(store.get("WorkSaveNo"+MediaID+".EPDetails.EP"+tempi+'.Condition')=="Watched"&&data.data[tempi-1].type!=2)
                {SyncContentWatched=SyncContentWatched+data.data[tempi-1].episode.id+','}}
              if(SyncContentWatched){$.ajax({
                url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID+"/episodes",
                type: 'PATCH',contentType: "application/json",dataType: "json",
                headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},
                data: '{"episode_id": ['+SyncContentWatched.slice(0, -1)+'],"type":2}',timeout : 2000,
                success: function () {;}, error: function () {;}
              })}
            }
            //再次检测是否已播放过
            for(let TempCounter = 1;TempCounter<=store.get("WorkSaveNo"+MediaID+".EPTrueNum");TempCounter++){
              if(store.get("WorkSaveNo"+MediaID+".EPDetails.EP"+TempCounter+'.Condition')=='Watched')
                {document.getElementById('ArchivePageContentDetailsEpisodeNo'+TempCounter).style.backgroundColor=SettingsColorPicker(0.4); //' rgb(240 145 153)'
                document.getElementById('ArchivePageContentDetailsEpisodeNo'+TempCounter).style.boxShadow='0px 0px 0px 2px '+SettingsColorPicker(1)} //' rgb(240 145 153)'
            } 
            ArchivePageMediaProgressCalc(MediaID);OKErrorStreamer("OK","加载作品信息完成,与云端同步成功",0);
            }
          }});}});
        }
    });
  }
  //?播放进度同步至云端
  if(sysdata.get("UserData.userpageProgressSyncOptions")=='Local'){ //如果设置为本地同步
    let SyncEPNum=null;  if (parseInt(store.get("WorkSaveNo"+MediaID+".EPTrueNum"))>parseInt(store.get("WorkSaveNo"+MediaID+".Eps"))) SyncEPNum = store.get("WorkSaveNo"+MediaID+".Eps"); else SyncEPNum = store.get("WorkSaveNo"+MediaID+".EPTrueNum");
    $.ajax({
      url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID.toString()+"/episodes?offset=0&episode_type=0",type: 'GET',headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken') +""},timeout : 2000,
      success:function(data){
        $.ajax({ //获取用户信息
          url: "https://api.bgm.tv/v0/me",type: 'GET',headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},timeout : 2000,
          success: function (data2) {
          $.ajax({ //获取收藏信息
            url: "https://api.bgm.tv/v0/users/"+data2.username+"/collections/"+bgmID,type: 'GET',dataType: "json",headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},timeout : 2000,
            success: function () {
              console.log("收藏的作品-同步云端");
              if(1){ //如果未收藏，不继续尝试同步
              let SyncContent = ''; //同步已看过章节
              for(let tempi = 1;tempi<=SyncEPNum;tempi++){
                if(store.get("WorkSaveNo"+MediaID+".EPDetails.EP"+tempi+'.Condition')=="Watched"&&data.data[tempi-1].type!=2)
                {SyncContent=SyncContent+data.data[tempi-1].episode.id+','}}
              if(SyncContent){$.ajax({
                url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID+"/episodes",
                type: 'PATCH',contentType: "application/json",dataType: "json",
                headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},
                data: '{"episode_id": ['+SyncContent.slice(0, -1)+'],"type": 2}',timeout : 2000,
                success: function () {;}, error: function () {;}
              })}
              let SyncContentUnwatched = ''; //同步未观看的动画剧集
              for(let tempi = 1;tempi<=SyncEPNum;tempi++)
                {if(store.get("WorkSaveNo"+MediaID+".EPDetails.EP"+tempi+'.Condition')=="Unwatched"&&data.data[tempi-1].type!=0)
                {SyncContentUnwatched=SyncContentUnwatched+data.data[tempi-1].episode.id+','}}
              if(SyncContentUnwatched){$.ajax({
                url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID+"/episodes",
                type: 'PATCH',contentType: "application/json",dataType: "json",
                headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},
                data: '{"episode_id": ['+SyncContentUnwatched.slice(0, -1)+'],"type":0}',timeout : 2000,
                success: function () {OKErrorStreamer("OK","加载作品信息完成,向云端同步成功",0);}, error: function () {;}
              })}
              }
            }});}});
          }
    });
  }
  

  //?填充科学排名
  if(sysdata.get("Settings.checkboxB.LocalStorageMediaShowSciMark")){ //判断是否显示科学排名
    document.getElementById("ArchivePageContentDetailsRatingRank").innerText="计算中...";
    $.getJSON("https://ghproxy.net/https://raw.githubusercontent.com/NeutrinoLiu/API/main/sciRank/shrank.json", function(data){
      for(let Temps = 0;Temps!=data.length;Temps++){if(data[Temps].i==bgmID) {document.getElementById("ArchivePageContentDetailsRatingRank").innerText="科排:"+data[Temps].r;break;}
        if(Temps>=data.length-1){document.getElementById("ArchivePageContentDetailsRatingRank").innerText="暂无排名"}}
    }).fail(function() {document.getElementById("ArchivePageContentDetailsRatingRank").innerText="获取失败";})}
  
  //?扫描特典
  ArchiveMediaBonusScan(store.get("WorkSaveNo"+MediaID+".URL"),MediaID);
  const folderButton=document.getElementById('ArchivePageContentDetailsFolderURL');
  folderButton.removeAttribute('onclick');
  folderButton.onclick=async()=>{
    const error=await shell.openPath(store.get('WorkSaveNo'+MediaID+'.URL'));
    if(error)OKErrorStreamer('Error','无法打开文件夹：'+error,0);
  };

  //页面内容填充
  console.log(MediaID);
  document.getElementById('ArchivePageContentDetailsCover').style.background = "block";
  document.getElementById("ArchivePageContentDetailsCover").style.background="url('"+store.get("WorkSaveNo"+MediaID+".Cover")+"') no-repeat center";
  document.getElementById("ArchivePageContentDetailsCover").style.backgroundSize="cover"; // 加载封面
  document.getElementById("ArchivePageContentDetailsTitle").innerHTML=store.get("WorkSaveNo"+MediaID+".Name"); // 加载标题
  //页面可见,背景初始化
  document.getElementById('ArchivePageContentDetails').style.marginLeft = '0%';
  document.getElementById('ArchivePageContentDetails').style.display = 'block'; // 页面可见化
  document.getElementById("ArchivePageContentDetailsBlur").style.background="url('"+store.get("WorkSaveNo"+MediaID+".Cover")+"') no-repeat center";
  document.getElementById("ArchivePageContentDetailsBlur").style.backgroundSize="cover";
  document.getElementById("ArchivePageContentDetailsBlur").style.filter="blur(40px) brightness(40%)";   // 渲染模糊背景
  document.getElementById("ArchivePageContentDetails").scrollTo(0,0); //页面回顶部
  //?启用性能模式
  if(sysdata.get("Settings.checkboxB.LocalStorageSystemOpenSpeedMode")==true){
    document.getElementById("ArchivePageContentDetailsBlur").style.background = "#404040";
    document.getElementById("ArchivePageContentDetailsBlur").style.filter = "unset";
    for (let i = 0; i < document.getElementsByClassName("RecentViewDetail").length; i++) {
      document.getElementsByClassName("RecentViewDetail")[i].style.backdropFilter = "brightness(1)";
    }
  }
  //贴边控制
  document.getElementById("ArchivePageContentDetailsTitle").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制标题贴边
  document.getElementById("ArchivePageContentDetailsTitleJp").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制日文标题贴左边
  document.getElementById("ArchivePageContentDetailsTitleJp").style.top=(22+(document.getElementById("ArchivePageContentDetailsTitle").getBoundingClientRect().height)*2/($(window).height())*100).toString()+"%"; // 控制日文标题贴上边
  // document.getElementById("ArchivePageContentDetailsFolderURL").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制打开文件夹按钮贴左边
  // document.getElementById("ArchivePageContentDetailsEditor").style.left=(34+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制作品编辑按钮贴左边
  document.getElementById("ArchivePageContentDetailsBannerButtonContainer").style.left=(22+(document.getElementById("ArchivePageContentDetailsCover").getBoundingClientRect().width)/($(window).width())*100).toString()+"%"; // 控制作品详情按钮贴左边
  //返回按钮显示
  document.getElementById('GoBackPage').style.display = 'block';
  setTimeout(function() {document.getElementById('GoBackPage').style.height = '45px';},100); // 返回按钮可见化

}


//! 媒体库-作品详情页好友评价卡片
function ArchiveMediaDetailsFriendRankCard(friend_comment,friend_score,friend_rank,friend_name,friend_id,friend_avatar,friend_time,bgmID_temp){
  document.getElementById('RecentViewFriendRankCard').style.display='block';
  document.getElementById('RecentViewFriendRankCardBack').style.display='block';
  // 若无评论则显示暂无评价
  if (friend_comment=="null") friend_comment = '暂无评价';
  // 更新评价卡片内容
  $("#RecentViewFriendRankCard").html("<div class='avatar' style='background: url(\"https:"+friend_avatar+"\") center center / cover no-repeat;position: absolute;height: 60px;left: 15px;top: 15px;'></div>"+
    "<div style='position: absolute;left: 95px;top: 15px;font-size: 20px;overflow: hidden;display: -webkit-box;text-overflow: ellipsis;-webkit-box-orient: vertical;-webkit-line-clamp: 1;'>"+friend_name+"<a style='font-size: 15px;margin-left: 5px;color: #8f8f8f;'>@"+friend_id+"</a></div>"+
    "<div style='position: absolute;left: 95px;top: 50px;height: 30px;'>"+
    "<span name='ArchivePageContentDetailsFriendRankCardStars' class='ArchivePageContentDetailsfull-star'></span>"+
    "<span name='ArchivePageContentDetailsFriendRankCardStars' class='ArchivePageContentDetailsfull-star'></span>"+
    "<span name='ArchivePageContentDetailsFriendRankCardStars' class='ArchivePageContentDetailsfull-star'></span>"+
    "<span name='ArchivePageContentDetailsFriendRankCardStars' class='ArchivePageContentDetailsfull-star'></span>"+
    "<span name='ArchivePageContentDetailsFriendRankCardStars' class='ArchivePageContentDetailsfull-star'></span></div><div class='boxBlank' style='font-size: 15px;"+
    "font-family: bgmUI;width: auto;height: 20px;left: 253px;top: 48px;background: #ddd;color:#000;box-shadow: none;display: flex;justify-content: center;align-items: center;position: absolute;padding: 3px;padding-left: 10px;padding-right: 10px;'>"+friend_rank+"</div>"+
    "<div class='ArchivePageContentDetailsFriendComments'>"+friend_comment+"</div>"+
    "<button type='button' value='链接' class='Winui3button' style='width:30px;border-top-right-radius: 0px;border-bottom-right-radius: 0px;bottom: 15px;right: 70px;height:35px' onclick=\"shell.openExternal('https://bgm.tv/subject/"+bgmID_temp+"/collections?filter=friends');\">"+
    "<svg t='1673539124397' class='icon' viewBox='0 0 1024 1024' version='1.1' xmlns='http://www.w3.org/2000/svg' p-id='3567' width='20' height='20'><path d='M853.333333 469.333333a42.666667 42.666667 0 0 0-42.666666 42.666667v256a42.666667 42.666667 0 0 1-42.666667 42.666667H256a42.666667 42.666667 0 0 1-42.666667-42.666667V256a42.666667 42.666667 0 0 1 42.666667-42.666667h256a42.666667 42.666667 0 0 0 0-85.333333H256a128 128 0 0 0-128 128v512a128 128 0 0 0 128 128h512a128 128 0 0 0 128-128v-256a42.666667 42.666667 0 0 0-42.666667-42.666667z' fill='#ffffff' p-id='2787'></path><path d='M682.666667 213.333333h67.413333l-268.373333 267.946667a42.666667 42.666667 0 0 0 0 60.586667 42.666667 42.666667 0 0 0 60.586666 0L810.666667 273.92V341.333333a42.666667 42.666667 0 0 0 42.666666 42.666667 42.666667 42.666667 0 0 0 42.666667-42.666667V170.666667a42.666667 42.666667 0 0 0-42.666667-42.666667h-170.666666a42.666667 42.666667 0 0 0 0 85.333333z' fill='#ffffff' p-id='2788'></path></svg>"+
    "</button><button type='button' value='关闭' class='Winui3button_red' style='width: 50px;bottom: 15px;border-top-left-radius: 0px;border-bottom-left-radius: 0px;height:35px;font-size: 15px;color: #fff;' onclick=\"document.getElementById('RecentViewFriendRankCard').style.display='none';document.getElementById('RecentViewFriendRankCardBack').style.display='none';\">关闭</button>");
  //根据评价文本长度自动设定卡片高度
  var textHeight = $(".ArchivePageContentDetailsFriendComments").prop('scrollHeight');
  $("#RecentViewFriendRankCard").height(textHeight + 170);  // 加上其他元素和边距的高度
  $("#RecentViewFriendRankCard").css('margin-top', (-1)*(textHeight + 170)/2); // 使卡片垂直居中
  //评分星星填充
  let FriendScoreVal=parseInt(friend_score); let index = parseInt(FriendScoreVal / 2);let spans = document.getElementsByName('ArchivePageContentDetailsFriendRankCardStars');
  for (let j = index; j < 5; j++) {spans[j].className = 'ArchivePageContentDetailsempty-star'}
  for (let k = 0; k < index; k++) {spans[k].className = 'ArchivePageContentDetailsfull-star'}
  if(index * 2 !== FriendScoreVal) {spans[index].className = 'ArchivePageContentDetailshalf-star'}
}

//! 媒体库-作品详情页章节选择弹窗 媒体库-作品详情页章节选择并播放
let { ArchiveMediaDetailsEpInfoCard,ArchiveMediaDetailsEpInfoPlayer,ArchiveMediaDetailsEpInfoCardWatched }
= nodeRequire('./js/Mainpage_Modules/MainpageArchiveDetailsSelectandPlay.js'); //?引入bgm.res主界面的作品详情页章节选择播放函数封装

//! 媒体库-作品详情页章节界面-自动分页章节渲染模块
const { ArchiveMediaDetailsAutoPageEpisodes,handleEpisodeScroll,ArchiveMediaDetailsAutoPageAction } 
= nodeRequire('./js/Mainpage_Modules/MainpageArchiveAutoPageEpisodes.js'); //?引入bgm.res主界面的作品详情页自动分页章节渲染模块

//! 媒体库-作品详情页条目用户收藏更新
function ArchiveMediaDetailsUserFavouriteUpdate(bgmID){
  let UpdateType = null;
  switch (document.getElementById('ArchivePageContentDetailsSelfRankBlockState').value)
  { 
    case 'wish': UpdateFavouriteData = '{"type": 1,"private": false}';UpdateType = '想看';break;
    case 'do':   UpdateFavouriteData = '{"type": 3,"private": false}';UpdateType = '在看';break;
    case 'collect': UpdateFavouriteData = '{"type": 2,"private": false}';UpdateType = '看过';break;
    case 'on_hold': UpdateFavouriteData = '{"type": 4,"private": false}';UpdateType = '搁置';break;
    case 'dropped': UpdateFavouriteData = '{"type": 5,"private": false}';UpdateType = '抛弃';break;
    case 'uncollect': UpdateFavouriteData = '{"type": 0,"private": false}';UpdateType = '未收藏';break;
  }
  $.ajax({ //更新收藏信息
    url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID,
    type: 'PATCH',
    contentType: "application/json",
    dataType: "json",
    headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken') +""},
    data: UpdateFavouriteData,
    timeout : 2000,
    success: function (data) {OKErrorStreamer("OK","更新条目状态为"+UpdateType+"成功",0);}, error: function () {;}
});
}

//! 媒体库-作品详情页章节进度云端更新
function ArchiveMediaDetailsEpisodeUserUpdate(bgmID,EPBegin,EPEnd,type){
  if(sysdata.get('UserData.userpageProgressSyncOptions')!="Disabled"){
  let SyncContent = null;
  $.ajax({
    url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID.toString()+"/episodes?offset=0&episode_type=0",type: 'GET',headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken') +""},timeout : 2000,
    success:function(data){
      for(let tempi = EPBegin;tempi!=EPEnd;tempi++) SyncContent = SyncContent+data.data[tempi-1].episode.id+','
    $.ajax({
      url: "https://api.bgm.tv/v0/users/-/collections/"+bgmID+"/episodes",
      type: 'PATCH',contentType: "application/json",dataType: "json",
      headers: {"Authorization": "Bearer "+ sysdata.get('UserData.UserToken')},
      data: '{"episode_id": ['+SyncContent.slice(0, -1)+'],"type":'+type+'}',timeout : 2000,
      success: function () {
        for(let tempi = EPBegin;tempi!=EPEnd;tempi++) {
          if(document.getElementById("ArchivePageContentDetailsEpisodeNo"+tempi) != null && sysdata.get('UserData.userpageProgressSyncOptions')!="Local" && type==2) //判断元素是否存在
          document.getElementById("ArchivePageContentDetailsEpisodeNo"+tempi).style.boxShadow = "0px 0px 0px 2px "+SettingsColorPicker(1);} //更新章节状态
        OKErrorStreamer("OK","章节"+EPBegin+"到"+(EPEnd-1)+"同步成功",0);
      }, error: function () {OKErrorStreamer("Error","章节"+EPBegin+"到"+(EPEnd-1)+"标注成功，同步失败",0);}
    })
  }})
  }
}

//! 媒体库-作品ep,sp特典扫描模块
const { LocalWorkEpsScanModule,ArchiveMediaBonusScan } = nodeRequire('./js/Mainpage_Modules/MediapageArchiveEPSPScanner.js'); //?引入bgm.res主界面的作品详情页作品ep,sp特典扫描模块

//! 恢复出厂设置
function SettingsClear(){
  var result = dialog.showMessageBoxSync({
    type:"warning",
    buttons:["取消","确认"],
    title:"警告",
    message:`您确定要清除全部用户数据吗？此操作不可逆，您的所有设置数据将清除！`
  });
  if(result == 1){
    sysdata.clear();/*localStorage.clear();*/SysdataDefaultInit();setTimeout(function(){ArchivePageInit();OKErrorStreamer("OK","设置删除完成",0);},500);}
}

//! 自定颜色获取
function SettingsColorPicker(opacity){
  //自定颜色获取
  let CustomColor = 'rgb(240 145 153)'; // 这是默认的颜色
  if(sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor")) 
    CustomColor = sysdata.get("Settings.checkboxB.LocalStorageSystemCustomColor"); // 如果有自定义颜色，就使用自定义颜色
  let rgbValues = CustomColor.match(/\d+/g);
  if (rgbValues.length !== 3) throw new Error('Invalid RGB format'); // 如果不是 RGB 格式，抛出错误
  let [r, g, b] = rgbValues; // 构建 rgba 字符串\
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

//! 媒体库排序
function ArchivePageMediaSort(key){
  if (key=='Switch') //排序列表显示
  {
    //获取排序列表display属性
    let sortListDisplay = $('#ArchivePageMediaSortList').css('display');
    //判断是否显示排序列表
    if(sortListDisplay == 'grid') {
      $('#ArchivePageMediaSortList').css({height: '0px'});
      setTimeout(function() {$('#ArchivePageMediaSortList').css({display: 'none'});}, 200);
    }
    else {
      $('#ArchivePageMediaSortList').css({display: 'grid'});
      setTimeout(function() {$('#ArchivePageMediaSortList').css({height: '210px'});}, 1);
    }
  }
  else if (key=='AscOrder'){ //升序排序按钮选择
    let key_temp = sysdata.get('Settings.checkboxC.LocalStorageMediaSortType')[0];
    let order_temp = 'asc';
    sysdata.set('Settings.checkboxC.LocalStorageMediaSortType', [key_temp, order_temp]);
    OKErrorStreamer('MessageOn', '正在降序排序...');
    let MediaBaseTempDataSaver = store.sortDb(key_temp, order_temp);
    MediaBaseTempDataSaver.then((data) => { // 排序完成后的回调
      ArchivePageInit();
      OKErrorStreamer('MessageOff', '');
      $('#ArchivePageMediaSortListAsc').css({backgroundColor: SettingsColorPicker(0.5)});
      $('#ArchivePageMediaSortListDesc').css({backgroundColor: ''});
    });
  }
  else if (key=='DescOrder'){ // 降序排序按钮选择
    let key_temp = sysdata.get('Settings.checkboxC.LocalStorageMediaSortType')[0];
    let order_temp = 'desc';
    sysdata.set('Settings.checkboxC.LocalStorageMediaSortType', [key_temp, order_temp]);
    OKErrorStreamer('MessageOn', '正在降序排序...');
    let MediaBaseTempDataSaver = store.sortDb(key_temp, order_temp);
    MediaBaseTempDataSaver.then((data) => { // 排序完成后的回调
      ArchivePageInit();
      OKErrorStreamer('MessageOff', '');
      $('#ArchivePageMediaSortListAsc').css({backgroundColor: ''});
      $('#ArchivePageMediaSortListDesc').css({backgroundColor: SettingsColorPicker(0.5)});
    });
  }
  else {
    let order = sysdata.get('Settings.checkboxC.LocalStorageMediaSortType')[1];
    // 直接赋值的结果是 Promise 对象
    let MediaBaseTempDataSaver = store.sortDb(key, order);
    OKErrorStreamer('MessageOn', '正在排序...');
    MediaBaseTempDataSaver.then((data) => { // 排序完成后的回调
      ArchivePageInit();
      OKErrorStreamer('MessageOff', '');
      sysdata.set('Settings.checkboxC.LocalStorageMediaSortType', [key, order]); // 保存排序方式
      
      //?排序列表样式更新
      for (let i = 3; i <= 7; i++) {
        $('.ArchivePageMediaSortListContent').eq(i).css({backgroundColor: ''});;
      }
      switch(key){
        case 'Name': {$('.ArchivePageMediaSortListContent').eq(3).css({backgroundColor: SettingsColorPicker(0.5)});break;}//名称
        case 'Score': {$('.ArchivePageMediaSortListContent').eq(4).css({backgroundColor: SettingsColorPicker(0.5)});break;} //评分
        case 'Year':  {$('.ArchivePageMediaSortListContent').eq(5).css({backgroundColor: SettingsColorPicker(0.5)});break;} //年份
        case 'Type': {$('.ArchivePageMediaSortListContent').eq(6).css({backgroundColor: SettingsColorPicker(0.5)});break;} //类型
        case 'WorkSaveNo': {$('.ArchivePageMediaSortListContent').eq(7).css({backgroundColor: SettingsColorPicker(0.5)});break;} //默认
      }
    });
  }
}

//! 接受托盘菜单指令运行指定程序
ipcRenderer.on('MainWindow', (event, arg) => {
  switch(arg){
    case 'OpenMainPage': FloatBarAction("Home");break;
    case 'OpenMediaPage': FloatBarAction("Archive");break;
    case 'OpenTorrnetPage': FloatBarAction("Torrnet");break;
  }
});

window.onerror = function(message, source, lineno, colno, error) {
  OKErrorStreamer("MessageOff", "");
  OKErrorStreamer("ErrorHandler", "发生致命错误："+message+"，请打开开发人员工具查看详情 ");
  // 在这里处理异常，例如记录日志或显示用户友好的错误消息
  return false; // 返回 true 表示阻止默认的错误处理（例如在控制台中输出错误）
};
// Keep original UI and feature functions; adapt only bound media data.
const RenameBoundPlayer = RenameBindingBridge.wrapPlayer(ArchiveMediaDetailsEpInfoPlayer,{store,dialog});
ArchiveMediaDetailsEpInfoPlayer = RenameBoundPlayer;

let boundMetadataRefresh;
ipcRenderer.on('library:updated',()=>{clearTimeout(boundMetadataRefresh);boundMetadataRefresh=setTimeout(()=>store.update().then(()=>{
  for(const [key,work]of Object.entries(store.get())){
    if(!/^WorkSaveNo\d+$/.test(key))continue;
    const card=document.getElementById('ArchiveWorkNo'+key.slice(10));if(!card)continue;
    if(work.Cover)card.style.backgroundImage='url("'+work.Cover+'")';
    const title=card.querySelector('.ArchiveCardTitle');if(title)title.textContent=work.Name;
    const score=card.querySelector('.ArchiveCardRateStar');if(score)score.textContent='★ '+work.Score;
  }
}),800);});

if (process.env.BGM_SCROLL_DIAGNOSTICS === '1') {
  nodeRequire('./js/scroll-diagnostics.cjs').install({document,window});
}
