import { behavior, displayRows, currentRow, emphasized, validTokens, easeScroll } from './timeline.mjs';

const node = (tag, className, text) => {
  const element=document.createElement(tag);
  if (className) element.className=className;
  if (text !== undefined) element.textContent=text;
  return element;
};
const plainTokens = voice => validTokens(voice).map(t=>t.text+(t.spaceAfter?' ':'')).join('').trim();
const syllableText = token => token.text.replace(/[()]/g,'');

export class LyricView {
  constructor(container, { onSeek = () => {}, labels = () => ({ credits:'创作者：', separator:'、', aiTranslation:'翻译由 AI 生成' }) } = {}) {
    this.element=container;
    this.element.classList.add('lyric-scroll');
    this.onSeek=onSeek;
    this.labels=labels;
    this.time=0;
    this.index=-1;
    this.follow=true;
    this.translation=false;
    this.pronunciation=false;
    this.playing=false;
    this.abort=new AbortController();
    const listen=(event,handler)=>container.addEventListener(event,handler,{passive:true,signal:this.abort.signal});
    const intent=()=>{this.intentUntil=performance.now()+behavior.scrollIntentWindow;};
    listen('wheel',intent);
    listen('touchstart',()=>{this.touching=true;});
    listen('touchmove',()=>{if(this.touching) intent();});
    listen('touchend',()=>{this.touching=false;});
    listen('scroll',()=>{
      if (performance.now() < this.intentUntil) {
        this.setFollow(false);
        clearTimeout(this.resumeTimer);
        this.resumeTimer=setTimeout(()=>this.setFollow(true),behavior.scrollResumeDelay);
      }
    });
  }

  load(song) {
    this.stopAnimations();
    clearTimeout(this.resumeTimer);
    clearTimeout(this.optionTimer);
    clearTimeout(this.initialTimer);
    cancelAnimationFrame(this.scrollFrame);
    this.song=song;
    this.element.lang=song.language;
    this.rows=displayRows(song);
    this.index=-1;
    this.time=0;
    this.activations=new Map();
    this.element.replaceChildren();
    this.top=node('div','top-spacer');
    this.element.append(this.top);
    this.dom=this.rows.map((row,index)=>this.createRow(row,index));
    this.element.append(...this.dom.map(item=>item.element));
    this.bottom=node('div','bottom-spacer');
    this.element.append(this.bottom);
    this.element.scrollTop=0;
    this.setFollow(true);
    this.setOptions({translation:this.translation,pronunciation:this.pronunciation},false);
    this.resize();
    this.setTime(0,{instant:true});
    this.initialTimer=setTimeout(()=>requestAnimationFrame(()=>this.scrollToCurrent(true)),50);
  }

  createRow(row,index) {
    const element=node('div','lyric-row');
    const frame=node('div','row-frame');
    const button=node('button','line-button');
    button.type='button';
    element.dataset.index=index;
    element.dataset.key=row.key;
    if (!index) element.classList.add('first');
    const item={element,frame,button,animated:[]};
    frame.append(button);element.append(frame);
    if (row.kind === 'lyric') {
      if (row.agent !== 'v1') element.classList.add('secondary-vocalist');
      if (this.song.lines.some(line=>line.agent !== 'v1')) element.classList.add('duet');
      this.addVoice(item,row,false);
      if (row.background.tokens.length) this.addVoice(item,row.background,true);
    } else if (row.kind === 'instrumental') {
      element.classList.add('instrumental');
      button.disabled=true;
      const dots=node('span','dots');
      for (let i=0;i<3;i++) dots.append(node('span','dot'));
      button.append(dots);
    } else {
      element.classList.add('credits');
      const footer=node('div','credits-content');
      footer.append(node('span','credit-label'),node('span','credit-names'));
      if (this.song.translation.automatic) footer.append(node('div','translation-note'));
      button.append(footer);
      item.credits=footer;
      this.relabel(item);
    }
    button.addEventListener('click',()=>this.onSeek(row.begin));
    return item;
  }

  addVoice(item,voice,background) {
    const primary=node('div',background?'background-vocals':'primary-vocals');
    const words=validTokens(voice);
    if (!words.length) primary.textContent=voice.text;
    const identical=voice.tokens.every((t,i)=>t.text===voice.pronunciationTokens[i]?.text);
    for (const token of words) {
      const group=node('span',`token-group${token.spaceAfter?' space-after':''}`);
      const main=node('div','token-main');
      main.append(this.createSyllable(token,item));
      group.append(main);
      const pronunciation=voice.pronunciationTokens[voice.tokens.indexOf(token)];
      if (!identical && pronunciation) {
        const supplementary=node('span','token-pronunciation');
        supplementary.append(this.createSyllable(pronunciation,item));
        group.append(supplementary);
      }
      primary.append(group);
    }
    item.button.append(primary);
    if (voice.pronunciation && voice.pronunciation.toLowerCase() !== (plainTokens(voice)||voice.text).toLowerCase()) {
      item.button.append(node('div','pronunciation-text',voice.pronunciation));
    }
    if (voice.translation && voice.translation.toLowerCase() !== (plainTokens(voice)||voice.text).replace(/[()]/g,'').toLowerCase()) {
      item.button.append(node('div',`translation-text${background?' background-translation':''}`,voice.translation));
    }
  }

  createSyllable(token,item) {
    const span=node('span','syllable',syllableText(token));
    span.dataset.begin=token.begin;
    span.dataset.end=token.end;
    span.dataset.emphasis=String(emphasized(token));
    item.animated.push({span,token});
    return span;
  }

  activate(index) {
    const item=this.dom[index],row=this.rows[index];
    if (!item || row.kind !== 'lyric') return;
    // Each activation restarts the word sweep, including backward seeking.
    this.activations.set(index,performance.now());
    for (const {span,token} of item.animated) {
      if (emphasized(token)) {
        span.replaceChildren(...syllableText(token).split('').map(letter=>node('span','letter',letter)));
      }
    }
    if (!this.animationFrame) this.tick();
  }

  tick=()=>{
    const now=performance.now();
    for (const [index,started] of this.activations) {
      const row=this.rows[index];
      const first=row.tokens[0]?.begin ?? row.begin;
      const elapsed=now-started;
      for (const {span,token} of this.dom[index].animated) {
        const duration=token.end-token.begin;
        const local=elapsed-token.begin+first;
        const ratio=Math.max(0,Math.min(1,local/(duration||1)));
        if (emphasized(token)) {
          [...span.children].forEach((letter,i)=>{
            const age=local-duration/syllableText(token).length*i;
            const rise=Math.max(0,Math.min(1,age/500));
            const fall=Math.max(0,Math.min(1,(age-500)/500));
            letter.style.setProperty('--sweep',`${-20+110*rise+10*fall}%`);
            letter.style.setProperty('--glow',`${10*rise-6*fall}px`);
            letter.style.setProperty('--glow-alpha',.4*rise-.4*fall);
            letter.style.transform=`matrix(${1+.05*rise-.05*fall},0,0,${1+.05*rise-.05*fall},0,${-2.05*rise+.05*fall})`;
          });
        } else {
          span.style.setProperty('--sweep',`${-20+120*ratio}%`);
          const lift=Math.max(0,Math.min(1,(local-100)/(duration||1)));
          span.style.transform=`translateY(${-2*lift}px)`;
        }
      }
      const lastEnd=Math.max(...this.dom[index].animated.map(({token})=>token.end),first);
      if (elapsed>lastEnd-first+1100) this.activations.delete(index);
    }
    this.animationFrame=this.activations.size?requestAnimationFrame(this.tick):0;
  };

  setTime(time,{instant=false}={}) {
    if (!this.rows) return;
    const jump=Math.abs(time-this.time)>1000;
    this.time=time;
    const next=currentRow(this.rows,time);
    const changed=next!==this.index;
    const hadCurrent=this.index>=0;
    // Reference scroll targeting happens before Stencil commits the next row.
    // Measure the upcoming row against the old layout, including an expanded intro.
    const target = changed && this.dom[next] ? this.scrollTarget(next) : undefined;
    this.index=next;
    if (changed) {
      this.dom.forEach((item,i)=>{
        item.element.classList.toggle('current',i===next);
        item.element.classList.toggle('past',i<next);
        item.element.classList.toggle('near',i===next || i===next+1);
      });
      this.activate(next);
      if(this.follow&&hadCurrent) this.scrollToCurrent(instant,target);
    }
    if (jump) {this.setFollow(true);if(changed&&hadCurrent) this.scrollToCurrent(instant,target);}
    this.updateDots();
  }

  setFollow(follow) {
    this.follow=follow;
    this.element.classList.toggle('manual',!follow);
    this.element.dispatchEvent(new CustomEvent('followchange',{detail:follow}));
  }

  scrollTarget(index=this.index) {
    const rect=this.dom[index].element.getBoundingClientRect();
    return rect.y-this.top.getBoundingClientRect().height-behavior.scrollMargin+this.element.scrollTop;
  }

  scrollToCurrent(instant=false,target=this.index>=0?this.scrollTarget():0) {
    const item=this.dom[this.index];
    if (!item) return;
    const start=this.element.scrollTop;
    if (instant) {this.element.scrollTop=target;return;}
    cancelAnimationFrame(this.scrollFrame);
    const begin=performance.now();
    const animate=now=>{
      const progress=Math.min(1,(now-begin)/behavior.scrollDuration);
      this.element.scrollTop=start+(target-start)*easeScroll(progress);
      if (progress<1) this.scrollFrame=requestAnimationFrame(animate);
    };
    this.scrollFrame=requestAnimationFrame(animate);
  }

  setPlaying(playing) {this.playing=playing;this.updateDots();}
  updateDots() {
    this.dom?.forEach((item,index)=>{
      if (this.rows[index].kind!=='instrumental') return;
      const row=this.rows[index],dots=item.element.querySelector('.dots');
      dots.classList.toggle('playing',this.playing);
      dots.classList.toggle('ending',row.end-this.time>=0&&row.end-this.time<1500);
      [...dots.children].forEach((dot,i)=>{
        dot.classList.toggle('reached',this.time>=row.begin+(row.end-row.begin)/3*i&&this.time<row.end);
        dot.style.transitionDuration=`${(row.end-row.begin)/3}ms`;
      });
    });
  }

  resize() {
    const height=this.element.getBoundingClientRect().height;
    this.top.style.height=`${height*.3 || 75}px`;
    this.bottom.style.height=`${height*.4}px`;
  }

  setOptions({translation=this.translation,pronunciation=this.pronunciation},scroll=true) {
    this.translation=translation;
    this.pronunciation=pronunciation;
    this.element.classList.toggle('show-translation',translation);
    this.element.classList.toggle('show-pronunciation',pronunciation);
    if (scroll) {
      clearTimeout(this.optionTimer);
      this.optionTimer=setTimeout(()=>this.scrollToCurrent(),behavior.localizationDuration+150);
    }
  }

  /** Rewrites the credits footer after an interface language change. */
  relabel(item=this.dom?.find(entry=>entry.credits)) {
    if (!item?.credits) return;
    const text=this.labels(),footer=item.credits;
    footer.querySelector('.credit-label').textContent=text.credits;
    footer.querySelector('.credit-names').textContent=this.song.credits.join(text.separator);
    const note=footer.querySelector('.translation-note');
    if (note) note.textContent=text.aiTranslation;
  }

  stopAnimations() {cancelAnimationFrame(this.animationFrame);this.animationFrame=0;}
  destroy() {
    this.stopAnimations();cancelAnimationFrame(this.scrollFrame);
    clearTimeout(this.optionTimer);clearTimeout(this.resumeTimer);clearTimeout(this.initialTimer);this.abort.abort();
  }
}
