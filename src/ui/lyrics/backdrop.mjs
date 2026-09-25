// Artwork backdrop modeled from the live Apple Music Web scene. It draws four
// moving copies of the image, then applies a radial twist, blur, color grade,
// and dark overlay. The browser does all image processing locally.
const BLUR_RADIUS=90;
const colorChannel=(value,luminance)=>{
  const saturated=luminance+(value-luminance)*2.75;
  const contrasted=.5+(saturated-.5)*1.9;
  return Math.round(Math.max(0,Math.min(1,contrasted*.7))*255);
};
export class ArtworkBackdrop {
  constructor(canvas) {
    this.canvas=canvas;
    this.output=canvas.getContext('2d',{alpha:false});
    this.layers=document.createElement('canvas');
    this.layerContext=this.layers.getContext('2d',{willReadFrequently:true});
    this.twisted=document.createElement('canvas');
    this.twistContext=this.twisted.getContext('2d');
    this.blurred=document.createElement('canvas');
    this.blurContext=this.blurred.getContext('2d',{willReadFrequently:true});
    this.motion=matchMedia('(prefers-reduced-motion: reduce)');
    this.angles=[0,0,0,0];
    this.generation=0;
    this.frame=0;
    this.lastDraw=0;
    this.lastMotion=0;
    this.observer=new ResizeObserver(()=>this.resize());
    this.observer.observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const box=this.canvas.parentElement.getBoundingClientRect();
    // The scene is heavily blurred; a quarter-size buffer keeps its 15 fps
    // motion inexpensive without changing the visible color fields.
    this.scale=Math.max(1,Math.ceil(Math.max(box.width,box.height)/400));
    const width=Math.max(1,Math.ceil(box.width/this.scale));
    const height=Math.max(1,Math.ceil(box.height/this.scale));
    for(const surface of [this.canvas,this.blurred]){
      surface.width=width;
      surface.height=height;
    }
    this.sourcePad=Math.ceil(500/this.scale);
    this.blurPad=Math.ceil(BLUR_RADIUS*3/this.scale);
    this.layers.width=width+2*this.sourcePad;
    this.layers.height=height+2*this.sourcePad;
    this.twisted.width=width+2*this.blurPad;
    this.twisted.height=height+2*this.blurPad;
    this.pixels=this.twistContext.createImageData(this.twisted.width,this.twisted.height);
    if(this.current) this.draw(performance.now());
  }

  async setFile(file) {
    const generation=++this.generation;
    const bitmap=await createImageBitmap(file);
    if(generation!==this.generation){bitmap.close();return false;}
    this.previous?.close();
    this.previous=this.current;
    this.current=bitmap;
    this.fadeStart=performance.now();
    this.canvas.hidden=false;
    this.lastMotion=this.fadeStart;
    this.draw(this.fadeStart);
    if(!this.frame) this.frame=requestAnimationFrame(this.tick);
    return true;
  }

  /** Stops the motion loop while the lyric view is closed; the last frame stays drawn. */
  pause() {
    cancelAnimationFrame(this.frame);
    this.frame=0;
  }

  resume() {
    if(!this.current||this.frame) return;
    this.lastMotion=performance.now();
    this.frame=requestAnimationFrame(this.tick);
  }

  clear() {
    ++this.generation;
    this.current?.close();
    this.previous?.close();
    this.current=this.previous=undefined;
    this.canvas.hidden=true;
    cancelAnimationFrame(this.frame);
    this.frame=0;
  }

  drawSprite(image,x,y,size,angle,alpha) {
    const context=this.layerContext;
    context.save();
    context.globalAlpha=alpha;
    context.translate(x,y);
    context.rotate(angle);
    context.drawImage(image,-size/2,-size/2,size,size);
    context.restore();
  }

  drawImageCopies(image,alpha) {
    if(!image||alpha<=0) return;
    const {width,height}=this.canvas,offset=this.sourcePad;
    const [a,b,c,d]=this.angles;
    this.drawSprite(image,offset+width/2,offset+height/2,width*1.25,a,alpha);
    this.drawSprite(image,offset+width/2.5,offset+height/2.5,width*.8,b,alpha);
    this.drawSprite(image,offset+width/2+width/4*Math.cos(c*.75),offset+height/2+width/4*Math.sin(c*.75),width*.5,-c,alpha);
    this.drawSprite(image,offset+width/2+width*.1+width/4*Math.cos(d*.75),offset+height/2+width*.1+width/4*Math.sin(d*.75),width*.25,-d,alpha);
  }

  twistPixels() {
    const width=this.twisted.width,height=this.twisted.height;
    const sourceWidth=this.layers.width,sourceHeight=this.layers.height;
    const source=this.layerContext.getImageData(0,0,sourceWidth,sourceHeight).data;
    const target=this.pixels.data;
    const centerX=this.canvas.width/2,centerY=this.canvas.height/2,radius=900/this.scale;
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const dx=x-this.blurPad-centerX,dy=y-this.blurPad-centerY,dist=Math.hypot(dx,dy);
      const angle=dist<radius?-3.25*((radius-dist)/radius)**2:0;
      const cos=Math.cos(angle),sin=Math.sin(angle);
      const sampleX=Math.round(this.sourcePad+centerX+dx*cos-dy*sin);
      const sampleY=Math.round(this.sourcePad+centerY+dx*sin+dy*cos);
      const destination=(y*width+x)*4;
      if(sampleX<0||sampleX>=sourceWidth||sampleY<0||sampleY>=sourceHeight){
        target[destination]=target[destination+1]=target[destination+2]=target[destination+3]=0;
      } else {
        const origin=(sampleY*sourceWidth+sampleX)*4;
        target[destination]=source[origin];
        target[destination+1]=source[origin+1];
        target[destination+2]=source[origin+2];
        target[destination+3]=source[origin+3];
      }
    }
    this.twistContext.putImageData(this.pixels,0,0);
  }

  colorGrade() {
    const {width,height}=this.blurred;
    const context=this.blurContext;
    context.clearRect(0,0,width,height);
    context.filter=`blur(${BLUR_RADIUS/this.scale}px)`;
    context.drawImage(this.twisted,-this.blurPad,-this.blurPad);
    context.filter='none';
    const frame=context.getImageData(0,0,width,height),data=frame.data;
    // Apple's color matrix combines saturation, contrast and brightness before
    // clamping. Separate CSS filters clip after each step and lose vivid colors.
    for(let i=0;i<data.length;i+=4){
      const red=data[i]/255,green=data[i+1]/255,blue=data[i+2]/255;
      const luminance=.2125*red+.7154*green+.0721*blue;
      data[i]=colorChannel(red,luminance);
      data[i+1]=colorChannel(green,luminance);
      data[i+2]=colorChannel(blue,luminance);
    }
    context.putImageData(frame,0,0);
  }

  draw(now) {
    if(!this.current) return;
    const fade=Math.min(1,(now-this.fadeStart)/1667);
    this.layerContext.clearRect(0,0,this.layers.width,this.layers.height);
    this.drawImageCopies(this.previous,1-fade);
    this.drawImageCopies(this.current,fade);
    if(fade===1&&this.previous){this.previous.close();this.previous=undefined;}
    this.twistPixels();
    this.colorGrade();
    const context=this.output,{width,height}=this.canvas;
    context.filter='none';
    context.fillStyle='#fff';
    context.fillRect(0,0,width,height);
    context.drawImage(this.blurred,0,0);
    context.fillStyle='rgba(0,0,0,.5)';
    context.fillRect(0,0,width,height);
    context.fillStyle='rgba(255,255,255,.05)';
    context.fillRect(0,0,width,height);
  }

  tick=now=>{
    if(!this.current){this.frame=0;return;}
    if(!document.hidden&&now-this.lastDraw>=1000/15){
      const delta=Math.min(100,now-this.lastMotion)/1000;
      this.lastMotion=now;
      const rate=this.motion.matches?[.03,.03,.03,.03]:[.09,-.24,-.18,.12];
      this.angles.forEach((angle,index)=>this.angles[index]=angle+rate[index]*delta);
      this.draw(now);
      this.lastDraw=now;
    }
    this.frame=requestAnimationFrame(this.tick);
  };

  destroy() {
    this.clear();
    this.observer.disconnect();
  }
}
