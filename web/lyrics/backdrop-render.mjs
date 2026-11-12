// Artwork backdrop ported from YouLyPlus (src/modules/lyrics/dynamicBkg.js,
// https://github.com/ibratabian17/YouLyPlus). Three rotating copies of the
// artwork orbit on a small WebGL surface, then a separable Gaussian blur,
// Apple Music's saturation and scrims, and a dither finish the frame. On each
// beat (setPulse, from pulse.mjs) the layers swell, twist and speed up their
// orbits as YouLyPlus's audio beat sync does.
//
// The scene only touches canvases handed to it, so it runs unchanged inside a
// worker (OffscreenCanvas) or on the main thread as a fallback.
//
// The YouLyPlus code is used under the MIT License:
//
//   Copyright (c) 2025 Ibra Al Tabian
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

// The output is heavily blurred, so the layers render at about 128 px and the
// visible canvas at about 256 px (both shaped to the screen); CSS stretches it.
const RENDER_SIZE=128;
const CANVAS_SIZE=256;
const ARTWORK_SIZE=128;
const MIN_ASPECT=.4,MAX_ASPECT=3.5;
const BLUR_SIGMA=.08*RENDER_SIZE,BLUR_SIGMAS=3;
const FRAME_INTERVAL=1000/40;
// Seconds for the crossfade to a new artwork
const TRANSITION=.8;
// Apple Music draws a 50% black and a 13/255 white scrim over the saturated artwork
const SATURATE=2.5,BLACK_SCRIM=.5,WHITE_SCRIM=13/255;
// Per layer: spin (rad/s), orbit speed (turns/s, signed), orbit phase, orbit radius (x, y), base scale
const ROTATION_SPEEDS=[-.08,.08,.2];
const INITIAL_ROTATIONS=[.3,-2.1,2.4];
const ORBIT_SPEEDS=[-.09,.006,.01];
const ORBIT_PHASES=[0,.33,.66];
const ORBIT_X=[0,.75,.75],ORBIT_Y=[0,.75,.75];
const LAYER_SCALES=[1.4,1.26,1.26];
// Beat response per layer: extra rotation (rad), orbit speed-up and scale; the
// swell follows a beat in about 1/12 s and settles over about half a second
const BEAT_ROTATIONS=[.28,-.18,.02];
const BEAT_SPEEDS=[.8,.2,.5];
const BEAT_SCALES=[.2,.34,.39];
const BEAT_ATTACK=12,BEAT_DECAY=2;
const QUAD=new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]);

const LAYER_VERTEX=`
attribute vec2 a_position;
uniform vec4 u_layer; // rotation, scale, offset x, offset y
uniform float u_aspect;
uniform float u_height;
varying vec2 v_uv;
varying float v_edge;
void main() {
  gl_Position=vec4(a_position,0.,1.);
  vec2 p=vec2(a_position.x*.5*u_aspect,-a_position.y*.5)-u_layer.zw*vec2(u_aspect,1.);
  float s=sin(-u_layer.x),c=cos(-u_layer.x);
  p=vec2(p.x*c-p.y*s,p.x*s+p.y*c);
  v_uv=p/u_layer.y+.5;
  v_edge=u_layer.y*u_height;
}`;
// Each copy keeps an antialiased square edge, as the sprites of Apple's scene do
const LAYER_FRAGMENT=`
precision mediump float;
varying vec2 v_uv;
varying float v_edge;
uniform sampler2D u_artwork;
uniform float u_alpha;
void main() {
  vec2 e=min(v_uv,1.-v_uv);
  float aa=clamp(min(e.x,e.y)*v_edge+.5,0.,1.);
  if(aa<=0.) discard;
  vec4 color=texture2D(u_artwork,v_uv);
  gl_FragColor=vec4(color.rgb,color.a*u_alpha*aa);
}`;
const QUAD_VERTEX=`
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  gl_Position=vec4(a_position,0.,1.);
  v_uv=a_position*.5+.5;
}`;

/** One-sided Gaussian weights with neighbouring taps merged into single bilinear fetches. */
function gaussianTaps(sigma,sigmas) {
  const radius=Math.max(1,Math.ceil(sigma*sigmas));
  const weights=[];
  let sum=0;
  for(let k=0;k<=radius;k++){
    weights[k]=Math.exp(-k*k/(2*sigma*sigma));
    sum+=k?2*weights[k]:weights[k];
  }
  const g=weights.map(weight=>weight/sum),taps=[];
  for(let k=1;k<=radius;k+=2){
    if(k+1>radius){taps.push([k,g[k]]);continue;}
    const weight=g[k]+g[k+1];
    taps.push([(k*g[k]+(k+1)*g[k+1])/weight,weight]);
  }
  return {center:g[0],taps};
}

function blurFragment(kernel,post) {
  const f=value=>value.toFixed(8);
  const taps=kernel.taps.map(([offset,weight])=>
    `  c+=(texture2D(u_image,v_uv+u_step*${f(offset)}).rgb+texture2D(u_image,v_uv-u_step*${f(offset)}).rgb)*${f(weight)};`).join('\n');
  // The vertical pass also grades the color and dithers it, so the stretched
  // 8-bit canvas shows no banding
  const finish=post?`
  c=clamp(mix(vec3(dot(c,vec3(.2126,.7152,.0722))),c,${f(SATURATE)}),0.,1.);
  c=mix(c,vec3(0.),${f(BLACK_SCRIM)});
  c=mix(c,vec3(1.),${f(WHITE_SCRIM)});
  HP vec2 fc=gl_FragCoord.xy;
  c+=(noise(fc)+noise(fc+vec2(5.588238))-1.)/255.;
  c=clamp(c,0.,1.);`:'';
  return `
precision mediump float;
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define HP highp
#else
#define HP mediump
#endif
varying vec2 v_uv;
uniform sampler2D u_image;
uniform vec2 u_step;
float noise(HP vec2 p) { return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715)))); }
void main() {
  vec3 c=texture2D(u_image,v_uv).rgb*${f(kernel.center)};
${taps}${finish}
  gl_FragColor=vec4(c,1.);
}`;
}

export class BackdropScene {
  /** canvas: the visible output; makeCanvas(): creates a 2D work surface. Throws without WebGL. */
  constructor(canvas,makeCanvas) {
    this.canvas=canvas;
    this.makeCanvas=makeCanvas;
    this.reducedMotion=false;
    this.running=false;
    this.timer=0;
    this.frame=0;
    this.time=0;
    this.lastFrame=0;
    this.pulse=0;
    // Per layer: orbit time (sped up by beats) and the smoothed beat swell
    this.orbits=[0,0,0];
    this.beats=[0,0,0];
    this.transition=1;
    this.aspect=1;
    this.boxWidth=this.boxHeight=0;
    canvas.addEventListener?.('webglcontextlost',event=>{event.preventDefault();this.lost=true;this.stop();});
    canvas.addEventListener?.('webglcontextrestored',()=>{
      this.lost=false;
      this.setup();
      // The crossfade cannot resume without the old texture; show the current artwork
      if(this.artwork){this.current=this.upload(this.artwork);this.transition=1;}
      this.resize(this.boxWidth,this.boxHeight);
      this.schedule();
    });
    this.setup();
  }

  setup() {
    const gl=this.canvas.getContext('webgl',{alpha:false,depth:false,stencil:false,antialias:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
    if(!gl) throw new Error('WebGL unavailable');
    this.gl=gl;
    this.layerProgram=this.program(LAYER_VERTEX,LAYER_FRAGMENT,['u_layer','u_aspect','u_height','u_alpha']);
    const kernel=gaussianTaps(BLUR_SIGMA,BLUR_SIGMAS);
    this.blurH=this.program(QUAD_VERTEX,blurFragment(kernel,false),['u_step']);
    this.blurV=this.program(QUAD_VERTEX,blurFragment(kernel,true),['u_step']);
    // Every program binds a_position to location 0, so the quad stays bound once
    gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER,QUAD,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    this.targets=[0,1].map(()=>{
      const texture=this.texture(),framebuffer=gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      return {texture,framebuffer};
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.activeTexture(gl.TEXTURE0);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    this.renderWidth=this.renderHeight=0;
    this.current=this.previous=null;
  }

  program(vertex,fragment,uniforms) {
    const gl=this.gl,program=gl.createProgram();
    for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
      const shader=gl.createShader(type);
      gl.shaderSource(shader,source);
      gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)&&!gl.isContextLost()) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program,shader);
      gl.deleteShader(shader);
    }
    gl.bindAttribLocation(program,0,'a_position');
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)&&!gl.isContextLost()) throw new Error(gl.getProgramInfoLog(program));
    const result={program};
    for(const name of uniforms) result[name]=gl.getUniformLocation(program,name);
    return result;
  }

  texture() {
    const gl=this.gl,texture=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    return texture;
  }

  resize(boxWidth,boxHeight) {
    if(!boxWidth||!boxHeight) return;
    this.boxWidth=boxWidth;
    this.boxHeight=boxHeight;
    if(this.lost) return;
    const gl=this.gl;
    this.aspect=Math.min(MAX_ASPECT,Math.max(MIN_ASPECT,boxWidth/boxHeight));
    const root=Math.sqrt(this.aspect);
    this.canvas.width=Math.max(8,Math.round(CANVAS_SIZE*root));
    this.canvas.height=Math.max(8,Math.round(CANVAS_SIZE/root));
    const width=Math.max(8,Math.round(RENDER_SIZE*root)),height=Math.max(8,Math.round(RENDER_SIZE/root));
    if(width!==this.renderWidth||height!==this.renderHeight){
      this.renderWidth=width;
      this.renderHeight=height;
      for(const {texture} of this.targets){
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      }
    }
    // The big layer covers the diagonal, the orbiting ones the shorter side
    this.sizeFactors=[Math.sqrt(this.aspect*this.aspect+1)*Math.SQRT1_2,root,root];
    // Resizing clears the drawing buffer; redraw even while paused
    this.draw();
  }

  /** Downscales by halves to ARTWORK_SIZE (bilinear steps keep detail that one big step would alias away). */
  downscale(bitmap) {
    let source=bitmap,width=bitmap.width,height=bitmap.height;
    while(width>ARTWORK_SIZE*2||height>ARTWORK_SIZE*2){
      width=Math.max(ARTWORK_SIZE,width+1>>1);
      height=Math.max(ARTWORK_SIZE,height+1>>1);
      source=this.drawScaled(source,width,height);
    }
    return this.drawScaled(source,ARTWORK_SIZE,ARTWORK_SIZE);
  }

  drawScaled(source,width,height) {
    const surface=this.makeCanvas();
    surface.width=width;
    surface.height=height;
    const context=surface.getContext('2d');
    context.imageSmoothingQuality='high';
    context.drawImage(source,0,0,width,height);
    return surface;
  }

  upload(artwork) {
    const gl=this.gl,texture=this.texture();
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,artwork);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    return texture;
  }

  /** Crossfades to the bitmap while running; a paused scene switches at once so it never resumes mid-fade. */
  setImage(bitmap) {
    this.artwork=this.downscale(bitmap);
    bitmap.close();
    if(this.lost) return;
    const gl=this.gl;
    if(this.previous) gl.deleteTexture(this.previous);
    this.previous=this.current;
    this.current=this.upload(this.artwork);
    this.transition=this.previous&&this.running?0:1;
    if(this.transition===1&&this.previous){gl.deleteTexture(this.previous);this.previous=null;}
    this.draw();
    this.schedule();
  }

  clear() {
    this.stop();
    this.artwork=undefined;
    if(!this.lost) for(const texture of [this.current,this.previous]) if(texture) this.gl.deleteTexture(texture);
    this.current=this.previous=null;
    this.transition=1;
  }

  /** Runs the motion loop while the lyric view is open and the page is visible; the last frame stays drawn. */
  setRunning(running) {
    if(running===this.running) return;
    this.running=running;
    this.stop();
    this.schedule();
  }

  /** Beat strength 0..1 for the coming frames; ignored under reduced motion. */
  setPulse(pulse) {
    this.pulse=pulse;
  }

  setReducedMotion(reduced) {
    this.reducedMotion=reduced;
    this.schedule();
  }

  /** Reduced motion freezes the layers where they are; only crossfades still animate. */
  get animating() {
    return this.running&&this.current&&!this.lost&&(!this.reducedMotion||this.transition<1);
  }

  schedule() {
    if(!this.animating||this.timer||this.frame) return;
    this.lastFrame||=performance.now();
    if(typeof requestAnimationFrame==='function') this.frame=requestAnimationFrame(this.tick);
    else this.timer=setTimeout(()=>this.tick(performance.now()),FRAME_INTERVAL);
  }

  stop() {
    if(this.frame) cancelAnimationFrame(this.frame);
    clearTimeout(this.timer);
    this.frame=this.timer=0;
    this.lastFrame=0;
  }

  tick=now=>{
    this.frame=this.timer=0;
    if(!this.animating) return;
    const elapsed=now-this.lastFrame;
    // Requested frames arrive at the display rate; draw at about 40 fps
    if(elapsed<FRAME_INTERVAL-1){this.schedule();return;}
    this.lastFrame=now;
    const delta=Math.min(.1,elapsed/1000);
    if(!this.reducedMotion) this.advance(delta);
    if(this.transition<1){
      this.transition=Math.min(1,this.transition+delta/TRANSITION);
      if(this.transition===1&&this.previous){this.gl.deleteTexture(this.previous);this.previous=null;}
    }
    this.draw();
    this.schedule();
  };

  advance(delta) {
    this.time+=delta;
    const pulse=this.pulse;
    for(let i=0;i<3;i++){
      this.orbits[i]+=delta*(1+pulse*BEAT_SPEEDS[i]);
      const beat=this.beats[i];
      this.beats[i]+=(pulse-beat)*Math.min(1,(pulse>beat?BEAT_ATTACK:BEAT_DECAY)*delta);
    }
  }

  drawLayers(texture,alpha) {
    if(!texture||alpha<=.001) return;
    const gl=this.gl,{u_layer,u_alpha}=this.layerProgram,t=this.time;
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.uniform1f(u_alpha,alpha);
    for(let i=0;i<3;i++){
      const orbit=((ORBIT_PHASES[i]+ORBIT_SPEEDS[i]*this.orbits[i])%1)*Math.PI*2;
      const beat=this.beats[i],swell=beat*beat*(3-2*beat);
      gl.uniform4f(u_layer,INITIAL_ROTATIONS[i]+ROTATION_SPEEDS[i]*t+swell*BEAT_ROTATIONS[i],(LAYER_SCALES[i]+swell*BEAT_SCALES[i])*this.sizeFactors[i],ORBIT_X[i]*Math.cos(orbit),ORBIT_Y[i]*Math.sin(orbit));
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
  }

  draw() {
    if(!this.current||this.lost||!this.renderWidth) return;
    const gl=this.gl,[layers,blurred]=this.targets;
    // Pass 1: the layered artwork copies
    gl.bindFramebuffer(gl.FRAMEBUFFER,layers.framebuffer);
    gl.viewport(0,0,this.renderWidth,this.renderHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.layerProgram.program);
    gl.uniform1f(this.layerProgram.u_aspect,this.aspect);
    gl.uniform1f(this.layerProgram.u_height,this.renderHeight);
    gl.enable(gl.BLEND);
    if(this.transition<1) this.drawLayers(this.previous,1-this.transition);
    this.drawLayers(this.current,this.transition);
    gl.disable(gl.BLEND);
    // Pass 2: horizontal blur
    gl.bindFramebuffer(gl.FRAMEBUFFER,blurred.framebuffer);
    gl.useProgram(this.blurH.program);
    gl.uniform2f(this.blurH.u_step,1/this.renderWidth,0);
    gl.bindTexture(gl.TEXTURE_2D,layers.texture);
    gl.drawArrays(gl.TRIANGLES,0,6);
    // Pass 3: vertical blur, grade and dither onto the visible canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.useProgram(this.blurV.program);
    gl.uniform2f(this.blurV.u_step,0,1/this.renderHeight);
    gl.bindTexture(gl.TEXTURE_2D,blurred.texture);
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
}
