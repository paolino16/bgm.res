function progress(store,mediaId){
  if(mediaId==null||mediaId===''||mediaId===false)return 0;
  const prefix='WorkSaveNo'+String(mediaId),count=Number(store.find(prefix+'.EPTrueNum'));
  if(!Number.isFinite(count)||count<=0)return 0;
  let watched=0;for(let i=1;i<=count;i++)if(store.find(prefix+'.EPDetails.EP'+i+'.Condition')==='Watched')watched++;
  return watched/count*100;
}
module.exports={progress};
