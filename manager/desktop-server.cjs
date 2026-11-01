require('./server.cjs').start({openPath:async p=>{if(process.send)process.send({openPath:p});}}).then(s=>{
  console.log(JSON.stringify({url:s.url}));
  process.on('disconnect',()=>s.close().then(()=>process.exit()));
  process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
}).catch(e=>{console.error(e);process.exit(1);});
