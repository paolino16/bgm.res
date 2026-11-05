const fs=require('node:fs'),path=require('node:path');
function resolveStorage({project,appData,env=process.env}){
  const engine=env.BGM_RENAME_PROJECT||path.join(project,'engine');
  const ownPointer=path.join(engine,'.bgm-storage.json');
  // Read the old pointer only to locate existing records during the one-time adoption.
  const legacyPointer=path.resolve(project,'../Bangumi_Auto_Rename/.bgm-storage.json');
  const bundled=path.resolve(engine).toLowerCase()===path.resolve(project,'engine').toLowerCase();
  const pointer=fs.existsSync(ownPointer)||!bundled?ownPointer:legacyPointer;
  if(fs.existsSync(pointer)){
    const config=JSON.parse(fs.readFileSync(pointer,'utf8'));
    if(!path.isAbsolute(config.renameData)||path.basename(config.renameData).toLowerCase()!=='rename')throw Error('整理数据目录配置无效：'+pointer);
    if(!fs.existsSync(path.join(config.renameData,'task')))throw Error('已配置的整理数据目录不可访问：'+config.renameData);
    return {directory:path.dirname(config.renameData),renameData:config.renameData,engine};
  }
  const directory=env.BGM_RES_DATA_DIR||path.join(appData,'bgm.res-linked');
  return {directory,renameData:path.join(directory,'rename'),engine};
}
module.exports={resolveStorage};
