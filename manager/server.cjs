const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {Library}=require('./library.cjs');
async function start(options={}) {
  const dataDir=options.dataDir || process.env.BGM_MANAGER_DATA || path.join(process.env.LOCALAPPDATA || process.cwd(),'bgm-res-manager');
  await fs.mkdir(dataDir,{recursive:true});
  const library=new Library(path.join(dataDir,'library.sqlite'));
  const token=randomBytes(32).toString('hex'); let busy=false;
  const server=http.createServer(async(req,res)=>{
    if(req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403);res.end();return;}
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    const url=new URL(req.url,'http://localhost');
    try {
      if(url.pathname.startsWith('/api/')) {
        if(req.headers['x-library-token']!==token){res.writeHead(403);res.end();return;}
        if(req.method==='GET' && url.pathname==='/api/library'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(library.list()));return;}
        if(req.method!=='POST')throw Error('不支持的请求');
        if(busy){res.writeHead(409);res.end(JSON.stringify({error:'正在执行其他任务，请稍后重试'}));return;}
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024)throw Error('请求过大');}
        const body=JSON.parse(raw||'{}'); busy=true;
        let result;
        try {
          switch(url.pathname) {
            case '/api/import': result=await library.importRename(body.path);await library.check();break;
            case '/api/scan': result=await library.scan(body.path);await library.check();break;
            case '/api/check': result=await library.check();break;
            case '/api/metadata': result=await library.metadata(body.id,body.bgmId);break;
            case '/api/edit': library.editSubject(body.id,body);result={saved:true};break;
            case '/api/bind': library.bind(body.fileId,body.subjectId,body.episodeId);result={saved:true};break;
            case '/api/extra': library.classifyExtra(body.fileId);result={saved:true};break;
            case '/api/open': {
              const file=library.db.prepare('SELECT path FROM files WHERE id=?').get(body.fileId);
              if(!file)throw Error('文件不存在');
              if(options.openPath)await options.openPath(file.path);
              else throw Error('请在桌面客户端中打开目录');
              result={opened:true};break;
            }
            default: throw Error('接口不存在');
          }
        } finally {busy=false;}
        res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result||{}));return;
      }
      if(url.pathname==='/cover') {
        // Only cached subject artwork may be requested; this is not an arbitrary URL proxy.
        const s=library.db.prepare('SELECT cover FROM subjects WHERE id=?').get(url.searchParams.get('id'));
        if(!s?.cover) {res.writeHead(404);res.end();return;}
        const remote=new URL(s.cover);
        if(remote.protocol!=='https:' || !['lain.bgm.tv','lain.bangumi.tv'].includes(remote.hostname))throw Error('封面地址无效');
        const cache=path.join(dataDir,'covers');await fs.mkdir(cache,{recursive:true});
        const name=require('node:crypto').createHash('sha256').update(s.cover).digest('hex');const filename=path.join(cache,name);
        let bytes;try{bytes=await fs.readFile(filename);}catch(e){const r=await fetch(s.cover,{signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw Error('封面下载失败');bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>8*1024*1024)throw Error('封面过大');await fs.writeFile(filename,bytes);}
        res.setHeader('Content-Type','image/jpeg');res.setHeader('Cache-Control','private, max-age=86400');res.end(bytes);return;
      }
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      if(!files[url.pathname]){res.writeHead(404);res.end();return;}
      let content=await fs.readFile(path.join(__dirname,'ui',files[url.pathname]),'utf8');
      if(url.pathname==='/')content=content.replace('__SESSION_TOKEN__',token);
      res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':url.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
      res.end(content);
    }catch(e){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:e.message}));}
  });
  await new Promise(resolve=>server.listen(options.port||0,'127.0.0.1',resolve));
  return {server,library,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(()=>{library.close();resolve();}))};
}
module.exports={start};
if(require.main===module)start().then(s=>{console.log(JSON.stringify({url:s.url}));process.on('SIGTERM',()=>s.close().then(()=>process.exit()));}).catch(e=>{console.error(e);process.exit(1);});
