// Worker side of ArtworkBackdrop: owns the transferred OffscreenCanvas so the
// WebGL scene and its frame loop never compete with lyric scrolling on the main thread.
import { BackdropScene } from './backdrop-render.mjs';

let scene=null;
let generation=0;

self.onmessage=async({data})=>{
  if(!scene&&data.type!=='init') return;
  switch(data.type){
    case 'init':
      try {
        scene=new BackdropScene(data.canvas,()=>new OffscreenCanvas(1,1));
      } catch(error) {
        self.postMessage({type:'failed',error:String(error)});
        return;
      }
      scene.setReducedMotion(data.reducedMotion);
      scene.resize(data.width,data.height);
      break;
    case 'resize': scene.resize(data.width,data.height); break;
    case 'motion': scene.setReducedMotion(data.reducedMotion); break;
    case 'running': scene.setRunning(data.running); break;
    case 'pulse': scene.setPulse(data.pulse); break;
    case 'clear': ++generation; scene.clear(); break;
    case 'image': {
      const current=++generation;
      let shown=false;
      try {
        const bitmap=await createImageBitmap(data.file);
        if(current===generation){scene.setImage(bitmap);shown=true;}
        else bitmap.close();
      } catch(error) {
        self.postMessage({type:'image',id:data.id,shown:false,error:String(error)});
        return;
      }
      self.postMessage({type:'image',id:data.id,shown});
      break;
    }
  }
};
