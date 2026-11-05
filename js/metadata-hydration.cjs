// Fetch outside the write queue, then merge into the latest work snapshot.
function create({data,network,save,thumbnails,transaction,notify,report}){
  let running,requested=false;
  const {normalizeAirDate}=require('./air-date.cjs');
  const missingCover=work=>!work.Cover||work.Cover==='./assets/banner.jpg';
  const missing=work=>work?.RenameBinding&&(missingCover(work)||(!normalizeAirDate(work.AirDate)&&!work.AirDateChecked)||!work.RankChecked);
  async function batch(){
    const keys=Object.keys(data).filter(key=>missing(data[key])),errors=[];let done=0;
    async function worker(){while(keys.length){const key=keys.shift(),id=data[key]?.bgmID;try{
      let info=!missingCover(data[key])?await network.cachedSubject?.(id):null;
      if(!info){
        const response=await network.request({url:'https://api.bgm.tv/v0/subjects/'+id});
        if(response.status!==200)throw Error('HTTP '+response.status);
        info=JSON.parse(response.body);
      }
      await transaction(async()=>{
        const current=data[key];if(!missing(current)||String(current.bgmID)!==String(id))return;
        const date=normalizeAirDate(info.date);
        const rank=Number(info.rating?.rank);
        const next={...current,Rank:Number.isInteger(rank)&&rank>0?rank:null,RankChecked:true,AirDate:date||normalizeAirDate(current.AirDate),AirDateChecked:true,
          Year:date?date.slice(0,4):current.Year};
        if(missingCover(current))Object.assign(next,{Cover:info.images?.large||current.Cover,Score:info.rating?.score??current.Score,
          Type:info.platform||current.Type,Name:info.name_cn||info.name||current.Name,Eps:info.eps||current.Eps});
        await save(key,next);data[key]=next;await thumbnails.prepare({work:next});
      });
    }catch(error){errors.push({subject:id,error:error.message});}
    done++;if(done%8===0||!keys.length)notify();
    }}
    await Promise.all([worker(),worker(),worker()]);await report({done,errors});
  }
  function hydrate(){
    requested=true;
    if(!running)running=(async()=>{do{requested=false;await batch();}while(requested);})().finally(()=>{running=null;});
    return running;
  }
  return {hydrate};
}
module.exports={create};
