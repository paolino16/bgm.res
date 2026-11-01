// Electron workArea is already expressed in device-independent pixels.
function desktopBounds(area){
  const availableWidth=Math.max(1,area.width-24),availableHeight=Math.max(1,area.height-24);
  const width=Math.min(availableWidth,Math.max(960,Math.min(1440,Math.round(area.width*.92))));
  const height=Math.min(availableHeight,Math.max(620,Math.min(940,Math.round(area.height*.9))));
  return {width,height,minWidth:Math.min(960,width),minHeight:Math.min(600,height),x:area.x+Math.floor((area.width-width)/2),y:area.y+Math.floor((area.height-height)/2)};
}
module.exports={desktopBounds};
