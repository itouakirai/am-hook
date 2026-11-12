// Artwork backdrop for the lyric view (YouLyPlus's WebGL scene). The scene
// itself lives in backdrop-render.mjs; where the browser supports WebGL on an
// OffscreenCanvas it renders in a worker, so its frames cannot delay the lyric
// scroll frames.
import { BackdropScene } from './backdrop-render.mjs';

const workerSupported=canvas=>{
  if(!('transferControlToOffscreen' in canvas)||typeof OffscreenCanvas==='undefined'||typeof Worker==='undefined') return false;
  try {
    const probe=new OffscreenCanvas(1,1).getContext('webgl');
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!probe&&!!new OffscreenCanvas(1,1).getContext('2d');
  } catch {return false;}
};

export class ArtworkBackdrop {
  constructor(canvas) {
    this.canvas=canvas;
    this.motion=matchMedia('(prefers-reduced-motion: reduce)');
    this.generation=0;
    this.wanted=false;
    this.hasImage=false;
    this.running=false;
    this.requests=new Map();
    this.nextRequest=0;
    this.pulse=0;
    const box=this.box();
    if(workerSupported(canvas)){
      const offscreen=canvas.transferControlToOffscreen();
      this.worker=new Worker(new URL('./backdrop-worker.mjs',import.meta.url),{type:'module'});
      this.worker.onmessage=({data})=>{
        if(data.type==='failed') this.fail(data.error);
        else this.settle(data.id,data.shown,data.error);
      };
      this.worker.onerror=event=>{
        console.warn('[am-hook] 歌词背景 worker 出错',event.message);
        this.fail(event.message||'worker error');
      };
      this.worker.postMessage({type:'init',canvas:offscreen,reducedMotion:this.motion.matches,...box},[offscreen]);
    } else {
      this.scene=new BackdropScene(canvas,()=>document.createElement('canvas'));
      this.scene.setReducedMotion(this.motion.matches);
      this.scene.resize(box.width,box.height);
    }
    this.onMotion=()=>this.send({type:'motion',reducedMotion:this.motion.matches},scene=>scene.setReducedMotion(this.motion.matches));
    this.onVisibility=()=>this.sync();
    this.motion.addEventListener('change',this.onMotion);
    document.addEventListener('visibilitychange',this.onVisibility);
    this.observer=new ResizeObserver(()=>{
      const {width,height}=this.box();
      this.send({type:'resize',width,height},scene=>scene.resize(width,height));
    });
    this.observer.observe(canvas.parentElement);
  }

  box() {
    const {width,height}=this.canvas.parentElement.getBoundingClientRect();
    return {width,height};
  }

  send(message,local) {
    if(this.worker) this.worker.postMessage(message);
    else local(this.scene);
  }

  /** Starts or stops the scene loop so it only runs while wanted, drawn and visible. */
  sync() {
    const running=this.wanted&&this.hasImage&&!document.hidden;
    if(running===this.running) return;
    this.running=running;
    this.send({type:'running',running},scene=>scene.setRunning(running));
  }

  settle(id,shown,error) {
    const request=this.requests.get(id);
    if(!request) return;
    this.requests.delete(id);
    if(error) request.reject(new Error(error));
    else request.resolve(shown);
  }

  /** The worker could not create its WebGL scene: every load from now on fails, so the lyric view keeps its plain color. */
  fail(error) {
    this.failed=error;
    for(const id of [...this.requests.keys()]) this.settle(id,false,error);
  }

  async setFile(file) {
    const generation=++this.generation;
    let shown;
    if(this.failed) throw new Error(this.failed);
    if(this.worker){
      const id=++this.nextRequest;
      shown=await new Promise((resolve,reject)=>{
        this.requests.set(id,{resolve,reject});
        this.worker.postMessage({type:'image',id,file});
      });
    } else {
      const bitmap=await createImageBitmap(file);
      shown=generation===this.generation;
      if(shown) this.scene.setImage(bitmap);
      else bitmap.close();
    }
    if(!shown||generation!==this.generation) return false;
    this.canvas.hidden=false;
    this.hasImage=true;
    this.wanted=true;
    this.sync();
    return true;
  }

  /** Stops the motion loop while the lyric view is closed; the last frame stays drawn. */
  pause() {
    this.wanted=false;
    this.sync();
  }

  resume() {
    this.wanted=true;
    this.sync();
  }

  /** Beat strength 0..1, set every frame; the worker only hears about visible changes. */
  setPulse(pulse) {
    if(Math.abs(pulse-this.pulse)<.004&&(pulse>0||!this.pulse)) return;
    this.pulse=pulse;
    this.send({type:'pulse',pulse},scene=>scene.setPulse(pulse));
  }

  clear() {
    ++this.generation;
    this.hasImage=false;
    this.canvas.hidden=true;
    this.sync();
    this.send({type:'clear'},scene=>scene.clear());
  }

  destroy() {
    this.clear();
    this.observer.disconnect();
    this.motion.removeEventListener('change',this.onMotion);
    document.removeEventListener('visibilitychange',this.onVisibility);
    this.worker?.terminate();
  }
}
