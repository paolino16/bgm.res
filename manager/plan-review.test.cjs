const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const {reviewRows}=require('../js/plan-review.cjs');
const p=n=>path.resolve(n);
test('abnormal videos sort first and normal source order stays stable',()=>{const rows=['one.mkv','two.mkv','three.mkv','skip.mkv'].map(n=>({source:p(n),skip:n==='skip.mkv'}));const review={issues:[{reason:'conflict',sources:[p('two.mkv')]}],preview:rows.map(r=>({source:r.source,target:p('out/'+path.basename(r.source)),target_label:path.basename(r.source)}))};const result=reviewRows({},rows,review);assert.deepEqual(result.map(r=>path.basename(r.row.source)),['two.mkv','one.mkv','three.mkv','skip.mkv']);assert.equal(result[0].attention,true);assert.equal(result.at(-1).status,'跳过');assert.equal(rows[0].source,p('one.mkv'));});
test('unresolved row is flagged but valid previews remain visible',()=>{const rows=[{source:p('valid.mkv')},{source:p('unknown.mkv')}];const items=reviewRows({},rows,{issues:[{reason:'请选择章节',sources:[p('unknown.mkv')]}],preview:[{source:p('valid.mkv'),target:p('out/EP01.mkv'),target_label:'EP01.mkv'}]});assert.equal(items[0].status,'需核对');assert.equal(items[1].targetLabel,'EP01.mkv');});
test('subtitle conflicts attach to the matching video instead of unrelated rows',()=>{const rows=[{source:p('Show.mkv')},{source:p('Show.01.mkv')}];const result=reviewRows({},rows,{issues:[{reason:'字幕冲突',sources:[p('Show.01.chs.ass')]}],preview:rows.map(r=>({source:r.source,target:p('out/'+path.basename(r.source))}))});assert.equal(path.basename(result[0].row.source),'Show.01.mkv');assert.deepEqual(result[0].reasons,['字幕冲突']);assert.equal(result[1].attention,false);});

test('medium-confidence AI suggestions sort first without blocking a manually confirmed row',()=>{
 const rows=[{source:p('high.mkv'),ai:{confidence:'High',reason:'明确编号'}},{source:p('medium.mkv'),ai:{confidence:'Medium',reason:'双编号'}},{source:p('manual.mkv'),manual_mapping:true,ai:{confidence:'Medium',reason:'已手动确认'}}];
 const result=reviewRows({},rows,{issues:[],preview:rows.map(r=>({source:r.source,target:p('out/'+path.basename(r.source)),target_label:'target'}))});
 assert.equal(path.basename(result[0].row.source),'medium.mkv');assert.equal(result[0].attention,true);assert.equal(result.find(r=>r.row.manual_mapping).attention,false);
});

test('batch extra classification only changes selected files and preserves naming and other mappings',()=>{
 const {batchRows}=require('../js/plan-review.cjs');const rows=[{source:'one',category:'unresolved',episode_id:1,filename:'custom',version:'v2',subject_id:'42'},{source:'two',category:'episode',episode_id:2}];
 const result=batchRows(rows,['one'],'extra');assert.equal(result[0].category,'extra');assert.equal(result[0].episode_id,null);assert.equal(result[0].filename,'custom');assert.equal(result[0].subject_id,'42');assert.equal(result[1],rows[1]);assert.equal(rows[0].episode_id,1);
 assert.equal(batchRows(rows,['two'],'skip')[1].skip,true);assert.throws(()=>batchRows(rows,['one'],'episode'));
});


const nativePlan={context:{layout:'bangumi',subject_id:'80205',name:'南家三姐妹 夏日假期',episodes:[{id:306609,type:0,sort:14,name:''},{id:306610,type:0,sort:15,name:'后续'}],subjects:{}}};
const nativeRow={source:p('OAD03.mkv'),subject_id:'80205',category:'episode',episode_id:306609,episode:'3',filename:'',version:'',ai:{confidence:'Medium',reason:'OAD03对应独立作品的唯一章节'}};
test('accepting current OAD mapping preserves decisions, clears only AI warning and survives JSON reload',()=>{
 const {confirmMappings,isMappingConfirmed}=require('../js/plan-review.cjs');
 const before=JSON.stringify(nativeRow);const result=confirmMappings(nativePlan,[nativeRow],[nativeRow.source]);assert.equal(result.count,1);const row=result.rows[0];
 assert.equal(JSON.stringify(nativeRow),before);assert.equal(row.episode_id,306609);assert.equal(row.episode,'3');assert.equal(row.subject_id,'80205');assert.equal(row.manual_mapping,true);assert.ok(isMappingConfirmed(nativePlan,row));
 const copy=JSON.parse(JSON.stringify(row));const checked={issues:[],preview:[{source:copy.source,target:p('out/EP14.mkv')}]};const item=reviewRows(nativePlan,[copy],checked)[0];assert.equal(item.status,'已确认');assert.equal(item.attention,false);assert.equal(item.canConfirm,false);
});
test('bulk acceptance never guesses missing chapters, unknown subjects, skipped files or malformed collections',()=>{
 const {confirmMappings}=require('../js/plan-review.cjs');const rows=[nativeRow,{...nativeRow,source:p('unresolved.mkv'),category:'unresolved',episode_id:null},{...nativeRow,source:p('foreign.mkv'),subject_id:'unknown'},{...nativeRow,source:p('skip.mkv'),skip:true},{...nativeRow,source:p('invalid.mkv'),episode_id:999},{...nativeRow,source:p('collection.mkv'),category:'collection',episode_ids:[306609]}];
 const result=confirmMappings(nativePlan,rows,rows.map(r=>r.source));assert.equal(result.count,1);for(let i=1;i<rows.length;i++)assert.equal(result.rows[i],rows[i]);
});
test('human acceptance never hides filesystem conflicts or enables execution on an invalid target',()=>{
 const {confirmMappings}=require('../js/plan-review.cjs');const row=confirmMappings(nativePlan,[nativeRow],[nativeRow.source]).rows[0];
 const item=reviewRows(nativePlan,[row],{issues:[{reason:'目标冲突',sources:[row.source]}],preview:[{source:row.source,target:p('out/EP14.mkv')}]})[0];
 assert.equal(item.confirmed,true);assert.equal(item.attention,true);assert.deepEqual(item.validationReasons,['目标冲突']);assert.equal(item.reasons.some(r=>r.startsWith('AI ')),false);
});
test('changing an accepted chapter or filename invalidates its acceptance fingerprint',()=>{
 const {confirmMappings,isMappingConfirmed}=require('../js/plan-review.cjs');const row=confirmMappings(nativePlan,[nativeRow],[nativeRow.source]).rows[0];
 for(const changed of [{...row,episode_id:306610},{...row,filename:'different'}]){assert.equal(isMappingConfirmed(nativePlan,changed),false);const item=reviewRows(nativePlan,[changed],{issues:[],preview:[{source:changed.source,target:p('out/new.mkv')}]})[0];assert.ok(item.reasons.includes('映射已变化，请重新确认'));assert.equal(item.canConfirm,true);}
});
test('explicit subject assignment and valid multi-chapter collections are respected',()=>{
 const {confirmMappings,describeMapping}=require('../js/plan-review.cjs');
 assert.equal(confirmMappings({...nativePlan,context:{...nativePlan.context,requires_subject_assignment:true}},[{...nativeRow,subject_id:''}],[nativeRow.source]).count,0);
 assert.equal(confirmMappings(nativePlan,[{...nativeRow,category:'collection',episode_id:null,episode_ids:[306609,306610]}],[nativeRow.source]).count,1);
 assert.match(describeMapping(nativePlan,nativeRow),/南家三姐妹 夏日假期.*本篇 14/);
});
