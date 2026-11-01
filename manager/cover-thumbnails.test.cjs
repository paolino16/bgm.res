const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL,fileURLToPath}=require('node:url');
const {CoverThumbnails}=require('../js/cover-thumbnails.cjs');
test('poster thumbnails bound dimensions, reuse their cache, and leave originals unchanged',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-covers-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'covers'));const original=path.join(directory,'covers','original.jpg');await fs.writeFile(original,'original bytes');
  const url=pathToFileURL(original).href;let decodes=0,size;
  const nativeImage={createFromPath(filename){assert.equal(filename,original);decodes++;return {isEmpty:()=>false,getSize:()=>({width:6000,height:4000}),resize(options){size=options;return {toJPEG:()=>Buffer.from('thumbnail bytes')};}};}};
  const cache=new CoverThumbnails({directory,nativeImage});
  await cache.prepare({one:{Cover:url},two:{Cover:url}});
  assert.deepEqual([size.width,size.height],[480,320]);assert.equal(decodes,1);
  const work=cache.decorate({one:{Cover:url}}).one;assert.equal(work.Cover,url);assert.match(work.DisplayCover,/cover-thumbnails/);
  assert.equal(await fs.readFile(original,'utf8'),'original bytes');assert.equal(await fs.readFile(fileURLToPath(work.DisplayCover),'utf8'),'thumbnail bytes');
  await new CoverThumbnails({directory,nativeImage}).prepare({one:{Cover:url}});assert.equal(decodes,1);
});
test('thumbnail generation skips unrelated local paths and tolerates damaged covers',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bgm-covers-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const cache=new CoverThumbnails({directory,nativeImage:{createFromPath(){return {isEmpty:()=>true};}}});
  const unrelated=pathToFileURL(path.join(directory,'other.jpg')).href;
  assert.equal(cache.source(unrelated),null);assert.equal(cache.source('https://example.com/a.jpg'),null);
  const cover=pathToFileURL(path.join(directory,'covers','bad.jpg')).href;
  await cache.prepare({one:{Cover:cover},two:{Cover:unrelated}});
  assert.equal(cache.decorate({one:{Cover:cover}}).one.DisplayCover,undefined);
});
