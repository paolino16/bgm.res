/**
 * @name MainpageArchiveAutoPageEpisodes.js
 * @module MainpageArchiveAutoPageEpisodes
 * @description 媒体库-支持分页的章节页面
 */


const style = document.createElement('style');
style.textContent = `
  /* 为特定容器自定义滚动条 */
  #ArchivePageContentDetailsEpisodePaginationWrapper {
    scrollbar-width: thin; /* Firefox */
    scrollbar-color: rgba(255, 255, 255, 0.4) rgba(0, 0, 0, 0.1); /* Firefox */
  }
  
  #ArchivePageContentDetailsEpisodePaginationWrapper::-webkit-scrollbar {
    height: 10px;
    width: 10px;
  }
  
  #ArchivePageContentDetailsEpisodePaginationWrapper::-webkit-scrollbar-track {
    background: #ffffff1f;
    border-radius: 5px;
    margin-left: 200px;
    margin-right: 200px;
    // width: 40%;
  }
  
  #ArchivePageContentDetailsEpisodePaginationWrapper::-webkit-scrollbar-thumb {
    background: ${SettingsColorPicker(0.4)};
    border-radius: 5px;
    // width: 40%;
  }
`;
document.head.appendChild(style);
//? 填充EP/SP选集列表 (分页逻辑)
var episodes = [];
var episodeElements = []; // Store generated button elements


//! 媒体库-支持分页的章节页面初始化
exports.ArchiveMediaDetailsAutoPageEpisodes = function (MediaID){
    //? 填充EP/SP选集列表 (分页逻辑)
    episodes = [];
    episodeElements = []; // Store generated button elements
  
    // 1. 准备 EP 数据
    const epCount = store.get("WorkSaveNo"+MediaID+".EPTrueNum") || 0;
    for (let i = 1; i <= epCount; i++) {
      episodes.push({ type: 'EP', number: i });
    }
  
    // 2. 生成所有章节按钮元素 (Keep existing style and logic)
    [...episodes].forEach(item => {
        const btn = document.createElement('div');
        btn.id = `ArchivePageContentDetailsEpisodeNo${item.number}`;
        // Keep original classes/styles if they exist, otherwise apply base styles
        btn.className = 'ArchiveCardHover'; // Assuming this class provides base styling
        btn.style.cssText = `
            width:100%; height:100%; padding:0px; font-family: bgmUIHeavy;
            font-size:25px; text-align:center; display:flex; justify-content:center;
            align-items:center; transition:all 0.3s cubic-bezier(0,0,0.2,1);
            box-shadow:0px 0px 0px 0px #ffffff4a; background-color:rgb(0,0,0,0.3);
            cursor: pointer; box-sizing: border-box;
        `; // Apply necessary styles directly or via CSS class
        btn.textContent = `${item.type} ${store.get(`WorkSaveNo${MediaID}.${item.type}Details.${item.type}${item.number}.EpisodeNumber`) || item.number}`;
        // Keep original onclick
        btn.onclick = (event) => ArchiveMediaDetailsEpInfoCard(event, MediaID, item.number, item.type);
  
        // 检测是否已播放过 (Keep original logic)
        const watchedKey = `WorkSaveNo${MediaID}.${item.type}Details.${item.type}${item.number}.Condition`;
        if (store.get(watchedKey) === 'Watched') {
            btn.style.backgroundColor = SettingsColorPicker(0.4); // Use your color function
            btn.style.boxShadow = "0px 0px 0px 2px "+SettingsColorPicker(0.4); // Use your color function
        }
        episodeElements.push(btn);
    });
    ArchiveMediaDetailsAutoPageAction(); // Call the function to handle pagination and display
}

exports.ArchiveMediaDetailsAutoPageAction = function (){
    const wrapper = document.getElementById('ArchivePageContentDetailsEpisodePaginationWrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';
    wrapper.removeEventListener('wheel', handleEpisodeScroll);
    if (!episodeElements.length) {
        wrapper.innerHTML = "<div class='episode-empty'>暂无章节信息</div>";
        return;
    }
    const grid = document.createElement('div');
    grid.className = 'ArchivePageContentDetailsEpisodePage';
    for (const button of episodeElements) grid.appendChild(button);
    wrapper.appendChild(grid);
};

//! 处理滚轮事件的函数
exports.handleEpisodeScroll = function(event) {
 const wrapper=document.getElementById('ArchivePageContentDetailsEpisodePaginationWrapper');
 if(wrapper)require('../horizontal-scroll.cjs').handleHorizontalWheel(event,wrapper);
};
