const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const VIDEO = /\.(mkv|mp4|avi|m2ts|ts|mov|webm|m4v|wmv)$/i;
const key = p => path.resolve(p).replaceAll('\\', '/').toLowerCase();
const idFor = (kind, value) => kind + ':' + createHash('sha256').update(value).digest('hex').slice(0, 24);
const readJSON = async p => JSON.parse(await fs.readFile(p, 'utf8'));
function hint(filename) {
  const name = path.basename(filename);
  const m = name.match(/(?:^|[\s._-])(?:S(\d+)E|EP|SP)(\d+(?:\.\d+)?)/i);
  return { number: m ? m[2] : null, type: /[\\/](Extras?|特典)[\\/]/i.test(filename) ? 'extra' : /[\\/]Specials[\\/]|\bSP\d/i.test(filename) || m?.[1] === '00' ? 'special' : 'episode', season: m?.[1] ?? null };
}
class Library {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS subjects(id TEXT PRIMARY KEY, bgm_id TEXT UNIQUE, title TEXT NOT NULL, year TEXT, cover TEXT, summary TEXT, score REAL, tags TEXT DEFAULT '[]', notes TEXT DEFAULT '', metadata_at TEXT);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, subject_id TEXT REFERENCES subjects(id), path TEXT NOT NULL, path_key TEXT UNIQUE NOT NULL, episode_id TEXT, episode_number TEXT, episode_type TEXT, binding TEXT, bytes INTEGER DEFAULT 0, status TEXT DEFAULT 'unchecked', origin TEXT, task_id TEXT, modified TEXT);
      CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, subject_id TEXT REFERENCES subjects(id), number TEXT, type INTEGER, title TEXT);
      CREATE TABLE IF NOT EXISTS roots(path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS file_subject ON files(subject_id);`);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  subject(bgm, title, year, identity) {
    bgm = /^\d+$/.test(String(bgm)) ? String(bgm) : null;
    const id = bgm ? 'bgm:' + bgm : idFor('local', identity || title);
    this.db.prepare(`INSERT INTO subjects(id,bgm_id,title,year) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id,bgm,title || '未命名条目',String(year || ''));
    return id;
  }
  file(subject, target, binding = {}, origin = 'scan', taskId = null) {
    const identity = key(target); const h = hint(target);
    const explicit = binding.episode_id != null && binding.subject_id != null;
    this.db.prepare(`INSERT INTO files(id,subject_id,path,path_key,episode_id,episode_number,episode_type,binding,origin,task_id,modified) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(path_key) DO UPDATE SET path=excluded.path, subject_id=CASE WHEN files.binding IN ('manual','manual-extra') THEN files.subject_id ELSE excluded.subject_id END,
      episode_id=CASE WHEN files.binding IN ('manual','manual-extra') OR (excluded.binding!='explicit' AND files.binding='explicit') THEN files.episode_id ELSE excluded.episode_id END,
      episode_number=CASE WHEN files.binding IN ('manual','manual-extra') OR (excluded.binding!='explicit' AND files.binding='explicit') THEN files.episode_number ELSE excluded.episode_number END,
      episode_type=CASE WHEN files.binding IN ('manual','manual-extra') OR (excluded.binding!='explicit' AND files.binding='explicit') THEN files.episode_type ELSE excluded.episode_type END,
      binding=CASE WHEN files.binding IN ('manual','manual-extra') OR (excluded.binding!='explicit' AND files.binding='explicit') THEN files.binding ELSE excluded.binding END,
      origin=excluded.origin,task_id=COALESCE(excluded.task_id,files.task_id),modified=excluded.modified`).run(
        idFor('file',identity),subject,path.resolve(target),identity,explicit ? String(binding.episode_id) : null,
        binding.episode != null ? String(binding.episode) : h.number,
        binding.category === 'extra' ? 'extra' : binding.episode_type != null ? (Number(binding.episode_type) === 0 ? 'episode' : Number(binding.episode_type) === 1 ? 'special' : 'extra') : h.type,
        explicit ? 'explicit' : 'unconfirmed',origin,taskId,new Date().toISOString());
  }
  async importRename(dataPath) {
    const tasksPath = path.join(dataPath,'task');
    const names = (await fs.readdir(tasksPath)).filter(n=>n.endsWith('.json'));
    const rows = [], errors = [];
    for (const name of names) {
      try {
        const task = await readJSON(path.join(tasksPath,name));
        const taskId = task.uuid || path.basename(name,'.json');
        let record;
        try { record = await readJSON(path.join(dataPath,'record',name)); }
        catch(e) { if(e.code !== 'ENOENT') throw e; errors.push({file:name,message:'没有执行记录，未导入计划路径'}); continue; }
        const entries = record.entries || record;
        const bindings = new Map((record.episode_bindings || task.episode_bindings || []).map(b=>[key(b.source),b]));
        for(const [source, entry] of Object.entries(entries)) {
          const target = typeof entry === 'string' ? entry : entry?.target;
          if(!target || !path.isAbsolute(target) || !VIDEO.test(target)) continue;
          const b = bindings.get(key(source)) || {};
          rows.push({task,taskId,target,b,bgm:b.subject_id || task.subject_id || task.bgm_id});
        }
      } catch(e) { errors.push({file:name,message:e.message}); }
    }
    const seen=new Map(), conflicts=new Set();
    for(const r of rows){const k=key(r.target),identity=String(r.bgm||'')+':'+String(r.b.episode_id||'');if(seen.has(k)&&seen.get(k)!==identity)conflicts.add(k);seen.set(k,identity);}
    for(const k of conflicts)errors.push({file:k,message:'多个任务对同一路径提供了不同的条目或章节，已跳过，需人工核对'});
    let imported=0;
    this.transaction(()=>{
      for(const r of rows) {
        if(conflicts.has(key(r.target)))continue;
        const sid=this.subject(r.bgm,r.task.bangumi_name || r.task.name,r.task.year,r.task.output_dir || r.target);
        this.file(sid,r.target,r.b,'rename',r.taskId);
        imported++;
      }
      this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('renamePath',path.resolve(dataPath));
    });
    return {files:imported,tasks:names.length,errors};
  }
  async scan(root) {
    root=path.resolve(root); const rows=[], errors=[];
    async function walk(dir,subjectRoot,depth=0) {
      if(depth>32) {errors.push({file:dir,message:'目录层级过深'});return;}
      let entries; try {entries=await fs.readdir(dir,{withFileTypes:true});} catch(e){errors.push({file:dir,message:e.message});return;}
      for(const e of entries) {
        if(e.isSymbolicLink()) continue;
        const full=path.join(dir,e.name);
        if(e.isDirectory()) await walk(full,subjectRoot || full,depth+1);
        else if(VIDEO.test(e.name)) rows.push({full,subjectRoot:subjectRoot || root});
      }
    }
    await fs.access(root); await walk(root,null);
    this.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO roots VALUES(?)').run(root);
      for(const row of rows) {
        if(this.db.prepare('SELECT id FROM files WHERE path_key=?').get(key(row.full))) continue;
        const title=path.basename(row.subjectRoot),year=title.match(/\((\d{4})\)$/)?.[1];
        const clean=title.replace(/\s*\(\d{4}\)$/,'');
        const sid=this.subject(null,clean,year,row.subjectRoot);
        this.file(sid,row.full);
      }
    });
    return {files:rows.length,errors};
  }
  async check() {
    const files=this.db.prepare('SELECT id,path FROM files').all(), results=[];
    const volumes=new Map();
    for(const f of files) {
      const volume=path.parse(f.path).root;
      if(!volumes.has(volume)) volumes.set(volume,await fs.access(volume).then(()=>true,()=>false));
      let status='offline',bytes=0;
      if(volumes.get(volume)) {try {const s=await fs.stat(f.path);status=s.isFile()?'available':'missing';bytes=s.size;} catch(e) {status=e.code==='ENOENT'?'missing':'unavailable';}}
      results.push({id:f.id,status,bytes});
    }
    this.transaction(()=>{const stmt=this.db.prepare('UPDATE files SET status=?,bytes=? WHERE id=?');for(const f of results)stmt.run(f.status,f.bytes,f.id);});
    return {checked:files.length};
  }
  list() {
    const subjects=this.db.prepare('SELECT * FROM subjects ORDER BY title COLLATE NOCASE').all();
    const files=this.db.prepare('SELECT * FROM files ORDER BY path').all();
    const by=new Map(); for(const f of files){if(!by.has(f.subject_id))by.set(f.subject_id,[]);by.get(f.subject_id).push(f);}
    for(const s of subjects){s.tags=JSON.parse(s.tags);s.files=by.get(s.id)||[];s.episodes=this.db.prepare('SELECT * FROM episodes WHERE subject_id=? ORDER BY type,CAST(number AS REAL)').all(s.id);}
    return {subjects,roots:this.db.prepare('SELECT path FROM roots').all().map(r=>r.path),renamePath:this.db.prepare("SELECT value FROM settings WHERE key='renamePath'").get()?.value || ''};
  }
  editSubject(id, data) {
    const tags=Array.isArray(data.tags)?data.tags.map(String).filter(Boolean).slice(0,30):[];
    this.db.prepare('UPDATE subjects SET tags=?,notes=? WHERE id=?').run(JSON.stringify(tags),String(data.notes||'').slice(0,10000),id);
  }
  bind(fileId,subjectId,episodeId) {
    const episode=this.db.prepare('SELECT * FROM episodes WHERE id=? AND subject_id=?').get(String(episodeId),subjectId);
    if(!episode)throw Error('章节不属于选定条目，请先获取条目资料');
    this.db.prepare("UPDATE files SET subject_id=?,episode_id=?,episode_number=?,episode_type=?,binding='manual' WHERE id=?").run(subjectId,episode.id,episode.number,episode.type===0?'episode':episode.type===1?'special':'extra',fileId);
  }
  classifyExtra(fileId) {
    this.db.prepare("UPDATE files SET episode_id=NULL,episode_number=NULL,episode_type='extra',binding='manual-extra' WHERE id=?").run(fileId);
  }
  async metadata(subjectId,bgmId) {
    if(!/^\d+$/.test(String(bgmId)))throw Error('请输入数字 Bangumi ID');
    const get=async endpoint=>{
      const response=await fetch('https://api.bgm.tv'+endpoint,{headers:{'User-Agent':'bgm-res-manager/0.1 (local collection; https://github.com/JimHans/bgm.res)'},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('Bangumi 请求失败：'+response.status);
      return response.json();
    };
    const info=await get('/v0/subjects/'+bgmId), episodes=[];
    if(info.type!==2)throw Error('该 ID 不是动画条目');
    let offset=0;
    while(true){const page=await get(`/v0/episodes?subject_id=${bgmId}&limit=100&offset=${offset}`);if(!Array.isArray(page.data))throw Error('章节响应无效');episodes.push(...page.data);offset+=page.data.length;if(offset>=page.total)break;if(!page.data.length)throw Error('章节列表不完整');}
    const old=this.db.prepare('SELECT * FROM subjects WHERE id=?').get(subjectId);
    if(!old)throw Error('条目不存在');
    const target='bgm:'+bgmId;
    this.transaction(()=>{
      this.subject(bgmId,info.name_cn||info.name,info.date?.slice(0,4));
      if(subjectId!==target){
        this.db.prepare('UPDATE files SET subject_id=?,episode_id=NULL,binding=\'unconfirmed\' WHERE subject_id=?').run(target,subjectId);
        const existing=this.db.prepare('SELECT * FROM subjects WHERE id=?').get(target);
        this.db.prepare('UPDATE subjects SET tags=?,notes=? WHERE id=?').run(JSON.stringify([...new Set([...JSON.parse(old.tags),...JSON.parse(existing.tags)])]),[existing.notes,old.notes].filter(Boolean).join('\n'),target);
        this.db.prepare('DELETE FROM episodes WHERE subject_id=?').run(subjectId);
        this.db.prepare('DELETE FROM subjects WHERE id=?').run(subjectId);
      }
      this.db.prepare('UPDATE subjects SET bgm_id=?,title=?,year=?,cover=?,summary=?,score=?,metadata_at=? WHERE id=?').run(String(bgmId),info.name_cn||info.name,info.date?.slice(0,4)||'',info.images?.large||'',info.summary||'',info.rating?.score||null,new Date().toISOString(),target);
      this.db.prepare('DELETE FROM episodes WHERE subject_id=?').run(target);
      const insert=this.db.prepare('INSERT INTO episodes VALUES(?,?,?,?,?)');
      for(const ep of episodes)insert.run(String(ep.id),target,String(ep.sort??ep.ep),ep.type,ep.name_cn||ep.name||'');
    });
    return {subjectId:target,episodes:episodes.length};
  }
}
module.exports={Library,hint,key,VIDEO};
