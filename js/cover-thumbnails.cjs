const fs=require('fs');
const path=require('path');
const {createHash}=require('crypto');
const {fileURLToPath,pathToFileURL}=require('url');
class CoverThumbnails{
  constructor({directory,nativeImage}){this.directory=directory;this.nativeImage=nativeImage;this.ready=new Map();}
  source(url){
    if(typeof url!=='string'||!url.startsWith('file:'))return null;
    let filename;try{filename=fileURLToPath(url);}catch{return null;}
    const relative=path.relative(path.join(this.directory,'covers'),filename);
    return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)?filename:null;
  }
  async prepare(data){
    const urls=[...new Set(Object.values(data).map(work=>work?.Cover).filter(url=>this.source(url)))];
    const folder=path.join(this.directory,'cover-thumbnails','v1');
    if(!urls.length)return;
    await fs.promises.mkdir(folder,{recursive:true});
    for(const url of urls){
      const destination=path.join(folder,createHash('sha256').update(url).digest('hex')+'.jpg');
      try{
        if(!fs.existsSync(destination)){
          const image=this.nativeImage.createFromPath(this.source(url));
          if(image.isEmpty())continue;
          const size=image.getSize(),scale=Math.min(1,480/size.width,720/size.height);
          const thumbnail=image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'good'});
          const temporary=destination+'.tmp';
          await fs.promises.writeFile(temporary,thumbnail.toJPEG(84));
          await fs.promises.rename(temporary,destination);
        }
        this.ready.set(url,pathToFileURL(destination).href);
      }catch{/* A bad cover must not prevent opening the library. */}
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
  decorate(data){for(const work of Object.values(data)){if(work&&typeof work==='object'&&this.ready.has(work.Cover))work.DisplayCover=this.ready.get(work.Cover);}return data;}
}
module.exports={CoverThumbnails};
