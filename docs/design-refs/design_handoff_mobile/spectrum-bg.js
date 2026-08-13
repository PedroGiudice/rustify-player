/* spectrum-bg.js — porta de src/components/SpectrumCanvas.tsx.
   Canvas global: monta UMA vez no shell, as telas passam por cima.
   shape (shapes.js) = "o quê"; renderer (renderers.js) = "como".
   Reatividade: 3 envelope followers (low/mid/high) → smoothedEnv (amplitude)
   + beat-sync em dois modos (1 speed = empurra a derivada do relógio,
   2 pulse = PLL trava fase e pulsa amplitude). Envelope nunca toca fase nem tinta.

   Diferença única em relação ao app: sem backend, não há evento `audio-fft`.
   O feed vem de um gerador (mockFft) na MESMA faixa dinâmica do payload real
   (low ~0.08–0.65) — todo o resto do pipeline é o código do app. */
(function(){
const SHAPE_KEY="rustify-shape-mobile",RENDER_KEY="rustify-renderer-mobile";
const S=window.SHAPES,R=window.RENDERERS,BP=window.BeatPll;
const FFT_STALE_MS=250,ENV_GAIN=0.5,ENV_TAU_MIN=0.1,ENV_TAU_MAX=0.8;
const DEFAULT_SHAPE=S.findIndex(s=>s.name==="pond"),DEFAULT_RENDER=R.findIndex(r=>r.name==="dots");

function loadIdx(key,len,def){try{const raw=localStorage.getItem(key);if(raw===null)return def;const n=parseInt(raw,10);if(Number.isFinite(n))return((n%len)+len)%len}catch(e){}return def}
let shapeIdx=loadIdx(SHAPE_KEY,S.length,DEFAULT_SHAPE),renderIdx=loadIdx(RENDER_KEY,R.length,DEFAULT_RENDER);
const shapeSubs=new Set(),renderSubs=new Set();
window.useShape={idx:()=>shapeIdx,name:()=>S[shapeIdx].name,count:S.length,
set(n){shapeIdx=((n%S.length)+S.length)%S.length;try{localStorage.setItem(SHAPE_KEY,String(shapeIdx))}catch(e){}shapeSubs.forEach(f=>f(shapeIdx))},
next(){this.set(shapeIdx+1)},prev(){this.set(shapeIdx-1)},on(f){shapeSubs.add(f);f(shapeIdx)}};
window.useRenderer={idx:()=>renderIdx,name:()=>R[renderIdx].name,count:R.length,
set(n){renderIdx=((n%R.length)+R.length)%R.length;try{localStorage.setItem(RENDER_KEY,String(renderIdx))}catch(e){}renderSubs.forEach(f=>f(renderIdx))},
next(){this.set(renderIdx+1)},prev(){this.set(renderIdx-1)},on(f){renderSubs.add(f);f(renderIdx)}};

/* Feed de FFT. No app vem de `audio-fft` (pw_capture.rs, smoothing assimétrico
   já aplicado no Rust). Aqui: 4/4 a 92 BPM, kick nos tempos, caixa em 2 e 4,
   hats nas colcheias — mesma faixa dinâmica do payload real. */
let lastLow=0,lastMid=0,lastHigh=0,lastFftAt=0;
window.pushFft=function(low,mid,high){lastLow=low;lastMid=mid;lastHigh=high;lastFftAt=performance.now()};
window.mockFft=function(isPlaying){
const BPM=92,beat=60/BPM;let t=0,last=performance.now();
const tick=()=>{const now=performance.now();const dt=Math.min(0.1,(now-last)*0.001);last=now;
if(!isPlaying())return;
t+=dt;
const b=(t/beat)%4;
const kickAge=(b%1)*beat;
const kick=0.08+0.57*Math.exp(-kickAge*11);
const snareOn=(b>=1&&b<2)||(b>=3&&b<4);
const snareAge=(b%1)*beat;
const snare=snareOn?0.30*Math.exp(-snareAge*8):0.05;
const hatAge=((t/(beat/2))%1)*(beat/2);
const hat=0.10+0.34*Math.exp(-hatAge*22);
const swell=0.06*Math.sin(t*0.25);
window.pushFft(Math.max(0,kick+swell),Math.max(0,0.22+snare+swell),Math.max(0,hat*0.8))};
window.__fftTick=tick;
setInterval(tick,120)};

window.mountSpectrum=function(canvas){
const ctx=canvas.getContext("2d");let w=0,h=0,dpr=1,raf=0;
let bgClock=0,smoothedEnv=0,lastFrameMs=performance.now();
const pll=BP.createBeatPll();
let beatEnv=0,beatSync=1,beatMode=1,beatDepth=BP.BEAT_DEPTH_DEFAULT;
let inkTgt={r:240,g:240,b:240},inkCur={r:240,g:240,b:240},inkSampled=false,inkRgb="240, 240, 240";
let bassGain=1.0,midGain=1.0,trebleGain=0.8,smoothing=0.3,speed=1.0,inkMorphTau=0.35,cfgCheckTick=0;

function resize(){dpr=Math.min(window.devicePixelRatio||1,1.5);const r=canvas.getBoundingClientRect();
w=Math.max(1,r.width);h=Math.max(1,r.height);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0)}
new ResizeObserver(resize).observe(canvas);resize();

function frame(){raf=requestAnimationFrame(frame);
if(document.hidden||!canvas.isConnected)return;
if(window.__fftTick)window.__fftTick();
cfgCheckTick++;
if(cfgCheckTick%20===0){const cs=getComputedStyle(document.documentElement);
const ink=cs.getPropertyValue("--bg-ink-rgb").trim();
if(ink){const p=ink.split(",").map(v=>parseFloat(v));
if(p.every(Number.isFinite)){inkTgt={r:p[0],g:p[1],b:p[2]};if(!inkSampled){inkCur={...inkTgt};inkSampled=true}}}
const num=k=>parseFloat(cs.getPropertyValue(k));
const b=num("--bg-bass-gain"),m=num("--bg-mid-gain"),tr=num("--bg-treble-gain"),sm=num("--bg-smoothing"),
sp=num("--bg-speed"),bs=num("--bg-beat-sync"),bm=num("--bg-beat-mode"),bd=num("--bg-beat-depth"),im=num("--bg-ink-morph");
if(Number.isFinite(b))bassGain=b;if(Number.isFinite(m))midGain=m;if(Number.isFinite(tr))trebleGain=tr;
if(Number.isFinite(sm))smoothing=sm;if(Number.isFinite(sp))speed=sp;if(Number.isFinite(bs))beatSync=bs;
if(Number.isFinite(bm))beatMode=bm;if(Number.isFinite(bd))beatDepth=bd;
inkMorphTau=Number.isFinite(im)&&im>0?im:0.35}

const tMs=performance.now();
const dt=Math.max(0,Math.min(0.1,(tMs-lastFrameMs)*0.001));
lastFrameMs=tMs;

const kInk=1-Math.exp(-dt/inkMorphTau);
inkCur.r+=(inkTgt.r-inkCur.r)*kInk;inkCur.g+=(inkTgt.g-inkCur.g)*kInk;inkCur.b+=(inkTgt.b-inkCur.b)*kInk;
inkRgb=`${Math.round(inkCur.r)}, ${Math.round(inkCur.g)}, ${Math.round(inkCur.b)}`;

const fresh=lastFftAt!==0&&tMs-lastFftAt<FFT_STALE_MS;
BP.pllStep(pll,lastLow,tMs*0.001,dt,fresh);

const speedTarget=fresh&&beatSync>0.5&&beatMode===1?BP.expandKick(lastLow):0;
beatEnv+=(speedTarget-beatEnv)*(1-Math.exp(-dt/BP.BEAT_TAU));
bgClock+=dt*speed*(1+BP.speedBoostGain(beatDepth)*beatEnv);
const t=bgClock;
ctx.clearRect(0,0,w,h);

let target=0;
if(fresh){const num2=bassGain*lastLow+midGain*lastMid+trebleGain*lastHigh,den=bassGain+midGain+trebleGain;
target=den>1e-3?num2/den:0}
const tau=ENV_TAU_MIN+smoothing*(ENV_TAU_MAX-ENV_TAU_MIN);
smoothedEnv+=(target-smoothedEnv)*(1-Math.exp(-dt/tau));

const breath=0.85+0.15*Math.sin(t*0.4);
const pulse=beatSync>0.5&&beatMode===2?BP.beatPulse(pll,beatDepth):0;
const reactive=1+ENV_GAIN*smoothedEnv+pulse;
const amp=h*0.17*breath*reactive;
const inkBoost=1+BP.INK_PULSE*(beatDepth>0?pulse/beatDepth:0);

/* correção de aspecto: as shapes são radiais em uv normalizado; num canvas
   360×780 isso viraria elipse. Comprimimos a faixa do eixo curto para que
   1 unidade de shape = mesma distância em px nos dois eixos. */
const aspectFn=(fn,w,h)=>{if(Math.abs(w-h)<1)return fn;
return w<h?((u,v,t)=>fn(0.5+(u-0.5)*(w/h),v,t)):((u,v,t)=>fn(u,0.5+(v-0.5)*(h/w),t))};

R[renderIdx].fn(ctx,w,h,t,aspectFn(S[shapeIdx].fn,w,h),amp,breath,inkRgb,smoothedEnv,inkBoost)}
raf=requestAnimationFrame(frame);
return()=>cancelAnimationFrame(raf)};
})();
