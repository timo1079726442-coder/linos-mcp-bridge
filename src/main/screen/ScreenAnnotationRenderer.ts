import { BrowserWindow, nativeImage } from "electron";

export type ScreenMark =
  | {kind:"box";x:number;y:number}
  | {kind:"arrow";x:number;y:number}
  | {kind:"text";x:number;y:number;text:string};

const MAX_MARKS=12;
const PNG_LIMIT=2*1024*1024;
const DATA_URL_LIMIT=2*1024*1024;

/** Conservative allowlist. Renderer input is untrusted, even behind local IPC. */
export function validateScreenMarks(value:unknown):ScreenMark[]{
  if(!Array.isArray(value)||value.length>MAX_MARKS)throw Error("SCREEN_MARKS_INVALID");
  return value.map((v:unknown):ScreenMark=>{
    if(!v||typeof v!=="object"||Array.isArray(v))throw Error("SCREEN_MARK_INVALID");
    const r=v as Record<string,unknown>;
    if((r.kind!=="box"&&r.kind!=="arrow"&&r.kind!=="text")||
       !Number.isInteger(r.x)||!Number.isInteger(r.y)||
       (r.x as number)<0||(r.x as number)>1000||
       (r.y as number)<0||(r.y as number)>1000)throw Error("SCREEN_MARK_INVALID");
    if(r.kind==="text"){
      if(typeof r.text!=="string"||r.text.trim().length<1||
         r.text.length>60||/[\u0000-\u001f\u007f]/.test(r.text)||
         Object.keys(r).some(key=>!["kind","x","y","text"].includes(key)))
        throw Error("SCREEN_MARK_TEXT_INVALID");
      return {kind:"text",x:r.x as number,y:r.y as number,text:r.text};
    }
    if(Object.keys(r).some(k=>!["kind","x","y"].includes(k)))
      throw Error("SCREEN_MARK_INVALID");
    return {kind:r.kind,x:r.x as number,y:r.y as number};
  });
}

/**
 * Own native Main-only screenshot bytes + small validated visual markup -> PNG.
 * Runs in a disposable isolated offscreen Electron window; never writes pixels
 * to disk or accepts arbitrary HTML/JS, images or external URLs from Renderer.
 */
/** Strip only optional PNG ancillary chunks. Preserve original critical chunks and CRCs. */
export function stripPngAncillaryMetadata(image:Buffer):Buffer {
  if(image.length<45||image.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")
    throw Error("ANNOTATION_PNG_INVALID");
  const pieces:Buffer[]=[image.subarray(0,8)];
  const allowed=new Set(["IHDR","PLTE","tRNS","IDAT","IEND"]);
  let offset=8,seenIdat=false,seenEnd=false;
  while(offset+12<=image.length){
    const len=image.readUInt32BE(offset);
    if(len>2*1024*1024||len+offset+12>image.length)throw Error("ANNOTATION_PNG_INVALID");
    const kind=image.toString("ascii",offset+4,offset+8);
    if(!/^[A-Za-z]{4}$/.test(kind))throw Error("ANNOTATION_PNG_INVALID");
    if(allowed.has(kind)){
      if(kind==="IDAT")seenIdat=true;
      pieces.push(image.subarray(offset,offset+12+len));
    }else if(kind.charAt(0)===kind.charAt(0).toUpperCase()){
      // Unknown critical chunks must never be silently removed.
      throw Error("ANNOTATION_PNG_CRITICAL_CHUNK");
    }
    offset+=12+len;
    if(kind==="IEND"){seenEnd=true;break;}
  }
  if(!seenIdat||!seenEnd||offset!==image.length)throw Error("ANNOTATION_PNG_INVALID");
  const clean=Buffer.concat(pieces);
  if(clean.length>2*1024*1024)throw Error("SCREEN_ANNOTATED_PNG_TOO_LARGE");
  return clean;
}

export async function renderAnnotatedPng(dataUrl:string,untrustedMarks:unknown):Promise<Buffer>{
  const marks=validateScreenMarks(untrustedMarks);
  if(!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)||
     dataUrl.length>DATA_URL_LIMIT)throw Error("SCREEN_SOURCE_INVALID");
  const view=new BrowserWindow({width:400,height:300,show:false,
    webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,
      webSecurity:true,offscreen:true}});
  try{
    await view.loadURL("about:blank");
    const script=`(async()=>{
      const src=${JSON.stringify(dataUrl)};
      const marks=${JSON.stringify(marks)};
      const image=new Image();
      image.src=src;
      await image.decode();
      const canvas=document.createElement("canvas");
      canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      if(!canvas.width||!canvas.height||canvas.width>1280||canvas.height>800)
        throw Error("SCREEN_SOURCE_SIZE_INVALID");
      const ctx=canvas.getContext("2d",{alpha:false});
      if(!ctx)throw Error("SCREEN_CANVAS_UNAVAILABLE");
      ctx.drawImage(image,0,0);
      ctx.lineWidth=Math.max(3,Math.round(canvas.width/280));
      ctx.strokeStyle="#f93635";ctx.fillStyle="#f93635";
      ctx.lineJoin="round";ctx.lineCap="round";
      const px=x=>x*canvas.width/1000,py=y=>y*canvas.height/1000;
      for(const mark of marks){
        const x=px(mark.x),y=py(mark.y);
        if(mark.kind==="box"){
          const bw=Math.min(canvas.width-x,canvas.width*.27);
          const bh=Math.min(canvas.height-y,canvas.height*.20);
          ctx.strokeRect(x,y,Math.max(5,bw),Math.max(5,bh));
        }else if(mark.kind==="arrow"){
          const startX=Math.max(0,x-canvas.width*.10);
          const startY=Math.max(0,y-canvas.height*.12);
          const dx=x-startX,dy=y-startY;
          const angle=Math.atan2(dy,dx),len=Math.max(10,canvas.width*.022);
          ctx.beginPath();ctx.moveTo(startX,startY);ctx.lineTo(x,y);
          ctx.lineTo(x-len*Math.cos(angle-.55),y-len*Math.sin(angle-.55));
          ctx.moveTo(x,y);ctx.lineTo(x-len*Math.cos(angle+.55),y-len*Math.sin(angle+.55));
          ctx.stroke();
        }else{
          ctx.font="bold "+Math.max(12,Math.round(canvas.width*.025))+"px sans-serif";
          ctx.lineWidth=3;ctx.strokeStyle="#ffffff";ctx.fillStyle="#f93635";
          ctx.strokeText(mark.text,x,y,Math.max(1,canvas.width-x));
          ctx.fillText(mark.text,x,y,Math.max(1,canvas.width-x));
          ctx.strokeStyle="#f93635";
        }
      }
      return canvas.toDataURL("image/png");
    })()`;
    const output:unknown=await view.webContents.executeJavaScript(script,true);
    if(typeof output!=="string"||!/^data:image\/png;base64,/.test(output))
      throw Error("SCREEN_ANNOTATION_RENDER_FAILED");
    const encoded=output.slice("data:image/png;base64,".length);
    const data=Buffer.from(encoded,"base64");
    if(data.length<33||data.length>PNG_LIMIT||data.toString("base64")!==encoded)
      throw Error("SCREEN_ANNOTATED_PNG_TOO_LARGE");
    // Normalize Chromium canvas PNG through Electron nativeImage to eliminate
    // ancillary PNG metadata chunks prohibited by the remote in-memory vault.
    const clean=nativeImage.createFromBuffer(data).toPNG();
    if(clean.length<33||clean.length>PNG_LIMIT)throw Error("SCREEN_ANNOTATED_PNG_TOO_LARGE");
    return stripPngAncillaryMetadata(clean);
  }finally{if(!view.isDestroyed())view.destroy();}
}