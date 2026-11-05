// Read-only comparison of cached subtitle detection. Neither version saves the index or runs media probes.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {execFileSync}=require('node:child_process');
async function main(){
 const root=path.resolve(__dirname,'..'),pointer=JSON.parse(await fs.readFile(path.join(root,'engine/.bgm-storage.json'),'utf8')),directory=path.dirname(pointer.renameData);
 const stored=JSON.parse(await fs.readFile(path.join(directory,'subtitle-index.json'),'utf8')),groups=new Map();
 for(const row of Object.values(stored.files||{})){if(!row.path||row.state!=='checked'||!row.signature||!Array.isArray(row.internal))continue;const folder=path.dirname(row.path);if(!groups.has(folder))groups.set(folder,[]);groups.get(folder).push(row.path);}
 let selected=[];for(const [,files]of [...groups].sort((a,b)=>b[1].length-a[1].length)){try{await fs.access(files[0]);selected=files.slice(0,48);break;}catch{}}
 if(!selected.length)throw Error('No available cached media sample');
 const baselineSource=execFileSync('git',['show','HEAD:js/subtitle-index.cjs'],{cwd:root,encoding:'utf8',windowsHide:true});
 const baseline=new Module(path.join(root,'js/subtitle-index.profile-baseline.cjs'));baseline.filename=baseline.id;baseline.paths=Module._nodeModulePaths(path.join(root,'js'));baseline._compile(baselineSource,baseline.filename);
 const classes={baseline:baseline.exports.SubtitleIndex,optimized:require('../js/subtitle-index.cjs').SubtitleIndex};
 const work={EPDetails:Object.fromEntries(selected.map((file,n)=>['EP'+n,{Versions:[{path:file}]}]))},runs=[];
 for(const version of ['baseline','optimized','baseline','optimized','baseline','optimized']){
  let reads=0,probes=0;const index=new classes[version]({directory,resolveTool:async()=>({}),probeFile:async()=>{probes++;throw Error('Uncached media probing is excluded from this benchmark');}});await index.load();index.save=async()=>{};
  const readdir=fs.readdir;fs.readdir=async(...args)=>{reads++;return readdir(...args);};const start=performance.now();let report;
  try{report=await index.scan(work);}finally{fs.readdir=readdir;}
  runs.push({version,milliseconds:Number((performance.now()-start).toFixed(2)),directoryReads:reads,uncachedProbesSkipped:probes,files:report.files.map(row=>({path:row.path,external:[...(row.external||[])].sort(),internal:row.internal}))});
 }
 const report={sampleFiles:selected.length,sourceDirectory:path.dirname(selected[0]),readOnly:true,osDiskCacheCleared:false,
  matchingResultsEqual:runs.every(run=>JSON.stringify(run.files)===JSON.stringify(runs[0].files)),runs:runs.map(({files,...timing})=>timing)};
 const output=path.join(root,'.desktop/subtitle-scan-profile.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
