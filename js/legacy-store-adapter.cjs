const core=require('./rename-binding-core.cjs');
class LegacyStoreAdapter{
  constructor(options={}){this.ipc=options.ipc||require('electron').ipcRenderer;this.data=this.ipc.sendSync('library:snapshot');}
  get(key){if(!key)return this.data;return core.getDeep(this.data,key.split('.'));}
  has(key){const parts=key.split('.');let obj=this.data;for(const k of parts){if(obj==null||!Object.prototype.hasOwnProperty.call(obj,k))return false;obj=obj[k];}return true;}
  set(key,value){const result=this.ipc.sendSync('library:write',{key,value});if(result.error)throw Error(result.error);core.setDeep(this.data,key.split('.'),value);}
  clear(){const r=this.ipc.sendSync('library:clear');if(r.error)throw Error(r.error);this.data={};}
  update(){this.data=this.ipc.sendSync('library:snapshot');return Promise.resolve(this.data);}
  sortDb(key,order='asc'){const result=this.ipc.sendSync('library:sort',{key,order});if(result.error)return Promise.reject(Error(result.error));this.data=result;return Promise.resolve(result);}
  find(key){if(!key)return this.data;const parts=key.split('.'),stable=parts.shift();const row=Object.values(this.data).find(v=>v?.WorkSaveNo===stable);return parts.length?core.getDeep(row,parts):row||false;}
  convertWorkSaveNo(stable){return Promise.resolve(Object.keys(this.data).find(k=>this.data[k]?.WorkSaveNo===stable)||false);}
  recordLastWatched(workID,episode){const records=(this.get('LastWatched')||[]).filter(r=>r.workID!==workID);const d=new Date();const pad=n=>String(n).padStart(2,'0');records.push({workID,episode,lastWatched:`${d.getFullYear()}年${pad(d.getMonth()+1)}月${pad(d.getDate())}日${pad(d.getHours())}时${pad(d.getMinutes())}分`});this.set('LastWatched',records.slice(-30));}
  getRecentWatchedData(){return this.get('LastWatched');}
  getTimeDifference(time){return require('./ElectronStore2NeDB.js').prototype.getTimeDifference.call(this,time);}
}
module.exports=LegacyStoreAdapter;
