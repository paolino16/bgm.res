# bgm.res

基于 Bangumi 的 Windows 本地番剧管理器，将媒体库、观看进度、字幕和资源整理集中在一个桌面窗口中。

这是 [JimHans/bgm.res](https://github.com/JimHans/bgm.res) 的个人 fork。资源整理引擎已并入 `engine/`，后续在本仓库维护。当前版本使用 Electron / CommonJS 与 Python / FastAPI，媒体库沿用 NeDB，整理任务和方案使用 JSON。

![新版媒体库](screenshots/library.png)

## 能做什么

- **浏览媒体库**：海报与列表视图，按名称、类型、年份、观看状态和字幕状态筛选，按评分、开播时间或进度排序。海报使用虚拟网格，大小可调整。
- **查看与续看**：作品详情、完整正片与特别章节目录、多版本文件、合集、特典和关联作品；通过系统播放器打开本地视频，记录看过、撤销或“看到这里”。
- **整理资源**：单文件、目录或整包来源识别，确认 Bangumi 归属，逐项审核文件到章节的映射、命名与输出位置，通过检查后执行入库。
- **管理字幕**：检测内封与外挂字幕，筛选缺失和待确认结果；选择多个字幕文件或目录，预览集号匹配、调整偏移和后缀后导入。
- **处理异常**：查看丢失、空文件等异常，清理登记记录；需要删除实际文件时显示确认并移入系统回收站。
- **调整外观**：默认中性石墨深色，支持浅色及其他配色、海报大小、背景与毛玻璃偏好，选择在本机保存。

## 新版界面

以下为新版桌面界面的隔离只读截图；截图环境不执行媒体整理或删除。

### 作品详情

![章节与本地版本](screenshots/detail.png)

### 字幕管理

![字幕检测与外挂导入](screenshots/subtitles.png)

### 偏好设置

![外观与媒体库设置](screenshots/settings.png)

## 准备与启动

当前仓库提供源码，没有附带安装包、Electron 便携运行时、播放器或用户数据。下面的准备方式适用于 Windows，并需要已有官方便携版运行时。

1. 安装 Python（依赖声明为 3.9 以上，本地已在 3.14 验证）及 Node.js。
2. 在仓库根目录准备 Python 环境：

   ```powershell
   python -m venv engine/.venv
   engine/.venv/Scripts/python.exe -m pip install -r engine/requirements.txt
   ```

3. 从已有官方便携版提取 Electron 运行时和 Node 依赖：

   ```powershell
   python manager/prepare-linked.py
   ```

   默认来源是 `%LOCALAPPDATA%\Programs\bgm.res-trial\app\win-unpacked`。其他安装位置可先设置：

   ```powershell
   $env:BGM_RUNTIME_SOURCE = 'D:\Apps\bgm.res\win-unpacked'
   python manager/prepare-linked.py
   ```

4. 双击根目录的 `启动 bgm.res.vbs`，或准备脚本生成的 `启动 bgm.res.cmd`。重复启动会聚焦已有窗口。

准备脚本将运行时放入 `.linked-desktop/`，依赖放入 `node_modules/`，不覆盖原安装。已有完整 npm 依赖与 Electron 开发环境时也可运行 `npm start`；沿用已有数据时应通过上述启动器进入。

## 整理一部作品

1. 在侧栏打开“资源整理”，选择来源文件或目录，启动识别。
2. 核对 Bangumi 条目；存在歧义时手动选择候选或填写 ID。整包可对应多个条目。
3. 打开待审核方案，检查每个文件的作品、资源类型、章节、版本与目标名称。可标记跳过，或将多集单文件设为“合集（正篇）”。
4. 确认正确映射，解决目标冲突、源文件丢失等问题，再更新检查。修改决定会使检查失效。
5. 检查通过后执行入库，完成后自动更新媒体库。

识别只生成方案。AI 辅助也需要手动发起，不会直接执行文件操作。可在整理设置中选择 GLM 或 DeepSeek 并填写对应密钥；请求发送相对文件名与候选章节，不上传视频。是否可用、赠送额度及实际费用取决于所配置服务。

后台任务可在离开页面后继续，关闭所有桌面窗口后，已排队和运行中的任务完成才退出后台。断电后的内存队列恢复尚未实现；任务记录与方案会保存在磁盘。

## 字幕与观看

作品详情的“字幕”页默认读取缓存，点击“检测本剧字幕”主动更新。可按状态或文件名筛选，展开查看轨道与路径。外挂导入需要作品已有整理记录；选择来源并生成匹配预览后，核对目标视频再提交。来源或偏移变化后需要重新预览，部分成功时仅保留未完成项。

正片和特别章节按 Bangumi 章节 ID 管理。目录获取失败时保留本地卡片并提示无法核对，不用不完整目录推断缺集。播放通过系统关联播放器打开文件；合集覆盖多个章节，仍参与观看进度与字幕检测。

## 数据与备份

- 默认桌面数据目录为 `%APPDATA%\bgm.res-linked`；`MediaData.db` 保存媒体库，`rename/` 保存整理配置、任务、记录、方案及日志。
- 已有引擎存储指针时沿用其指向的目录。`engine/.bgm-storage.json` 属于本机配置，不提交到仓库；首次接管可能读取原独立项目的指针定位历史数据。
- 封面、字幕和时长检测缓存保存在桌面数据目录。外观与排序等界面偏好保存在 Electron 用户配置中。
- 备份前退出桌面并等待后台任务结束，再备份整个实际数据目录。媒体文件需独立备份。
- 历史媒体链接、源路径和恢复日志可能仍依赖旧项目目录；清理旧程序源码不等于可以删除这些数据与路径。

旧版独立 SQLite 收藏管理入口、原版多窗口页面和整理引擎 NiceGUI 网页界面已移除。当前唯一桌面界面为 `desktop.html`，整理后台入口为 `python -m src.desktop_service`（在 `engine/` 下运行，由桌面自动管理）。

## 开发与验证

```powershell
node --test manager/*.test.cjs
engine/.venv/Scripts/python.exe manager/test-engine.py
```

Python 测试使用临时配置和输出目录。隔离 Electron 交互回归入口为 `manager/partial-render.electron.cjs`，需以开发 Electron 运行，覆盖局部渲染、输入保留、方案编辑及窄窗口布局。不要直接运行旧 `.desktop` 临时测试运行时。

目录分工：`index.js` 为桌面主进程，`desktop.html` 和 `js/library-desktop.cjs` 为界面，`js/organizer-desktop.cjs` 为整理审核界面，`engine/src/` 为整理引擎，`manager/` 为准备脚本、诊断工具和测试。详细行为见 [桌面版说明](manager/DESKTOP.md)，设计约定见 [DESIGN.md](DESIGN.md)。

## 来源与许可

本项目保留 [bgm.res](https://github.com/JimHans/bgm.res) 上游作者 JimHan 的版权与 [GPL-3.0 许可证](LICENSE)。合入的整理引擎保留 KimigaiiWuyi 的作者信息与 [原许可证](engine/LICENSE)。

感谢 [Bangumi API](https://github.com/bangumi/api)、[Electron](https://github.com/electron/electron)、[NeDB](https://github.com/louischatriot/nedb)、[mpv](https://github.com/mpv-player/mpv) 和 [FFmpeg](https://github.com/FFmpeg/FFmpeg) 等项目。各依赖及随运行时分发的组件适用其各自许可证。
