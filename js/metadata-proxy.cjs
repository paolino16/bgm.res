// Python requests cannot evaluate the system PAC used by Chromium.
const HOSTS=['api.bgm.tv','api.themoviedb.org','api.jikan.moe','api.tenrai.org'];
function proxyURL(rule){
  for(const entry of String(rule||'').split(';')){
    const value=entry.trim();
    if(/^DIRECT$/i.test(value))return null;
    const match=/^(PROXY|HTTPS)\s+(\S+)$/i.exec(value);
    if(match)return (match[1].toUpperCase()==='HTTPS'?'https://':'http://')+match[2];
  }
  return null;
}
async function metadataProxies(resolveProxy){
  const entries=await Promise.all(HOSTS.map(async host=>{
    try{return [host,proxyURL(await resolveProxy('https://'+host+'/'))];}
    catch{return [host,null];}
  }));
  return Object.fromEntries(entries.filter(([,proxy])=>proxy));
}
module.exports={metadataProxies,proxyURL};
