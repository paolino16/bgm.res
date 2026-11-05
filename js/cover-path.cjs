const fs=require('fs');
const path=require('path');
const {fileURLToPath,pathToFileURL}=require('url');
function resolveCover(url,directory){
  if(typeof url!=='string'||!url.startsWith('file:'))return url;
  let original;try{original=fileURLToPath(url);}catch{return url;}
  if(path.basename(path.dirname(original))!=='covers'||!/[\\/]bgm\.res(?:-linked)?[\\/]covers[\\/]/i.test(original))return url;
  const name=path.basename(original);
  if(!/^[a-f0-9]{64}\.jpg$/i.test(name))return url;
  const local=path.join(directory,'covers',name);
  return fs.existsSync(local)?pathToFileURL(local).href:url;
}
module.exports={resolveCover};
