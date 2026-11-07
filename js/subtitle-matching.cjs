const path=require('node:path');

// Match the EP numbers displayed in the library, not numbers guessed from filenames.
function chapterBindings(work){
  const chapters=[];
  for(const [key,slot]of Object.entries(work.EPDetails||{})){
    if(slot.Collection)continue;
    const number=Number(slot.EpisodeNumber||slot.LocalIndex||key.match(/^EP(\d+)$/)?.[1]);
    if(!Number.isFinite(number)||number<=0)continue;
    const files=[slot.AbsolutePath,...(slot.Versions||[]).map(version=>version.path),
      slot.URL&&work.URL?path.resolve(work.URL,slot.URL):null].filter(Boolean);
    chapters.push({id:key,number,kind:'EP',videos:[...new Set(files)]});
  }
  return chapters;
}

module.exports={chapterBindings};
