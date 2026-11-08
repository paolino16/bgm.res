'use strict';

// Keys match the source adapters in the subtitle worker. Each provider decides
// which metadata belongs in its result list.
module.exports={
  acgrip:{
    label:'VCB 论坛',
    metadata:row=>[row.author,row.date,row.board,row.stats]
  },
  assrt:{
    label:'伪射手',
    metadata:row=>[row.language,row.format,row.group,row.date]
  }
};
