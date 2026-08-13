/* beat-pll.js — porta 1:1 de src/lib/beatPll.ts (modo speed + modo pulse). */
(function(){
const KICK_FLOOR=0.1,KICK_CEIL=0.6;
function expandKick(low){const t=(low-KICK_FLOOR)/(KICK_CEIL-KICK_FLOOR);return Math.max(0,Math.min(1,t))}
const BEAT_TAU=0.09;
function speedBoostGain(depth){return depth*(1.0/0.55)}
const ONSET_RATIO=1.4,ONSET_FLOOR=0.2,ONSET_COOLDOWN=0.2,ONSET_AVG_TAU=0.35;
const PLL_PHASE_GAIN=0.5,PLL_TEMPO_GAIN=0.06,PLL_PERIOD_MIN=0.3,PLL_PERIOD_MAX=1.2,PLL_LOCK_RISE=0.3,PLL_LOCK_TAU=2.5;
const BEAT_DEPTH_DEFAULT=0.55,INK_PULSE=0.5,PULSE_GAIN=1.35;
function createBeatPll(){return{avgMag:0,lastOnsetT:-1,period:0.5,phase:0,locked:0}}
function pllStep(s,mag,t,dt,fresh){
let onset=false;
if(fresh){const m=expandKick(mag);
s.avgMag+=(m-s.avgMag)*(1-Math.exp(-dt/ONSET_AVG_TAU));
const ratio=m/(s.avgMag+1e-4);
onset=ratio>ONSET_RATIO&&m>ONSET_FLOOR&&t-s.lastOnsetT>ONSET_COOLDOWN;
if(onset)s.lastOnsetT=t}
s.phase+=dt/s.period;if(s.phase>=1)s.phase-=1;
if(onset){let e=s.phase;if(e>0.5)e-=1;
s.phase-=e*PLL_PHASE_GAIN;if(s.phase<0)s.phase+=1;
s.period*=1+e*PLL_TEMPO_GAIN;
s.period=Math.min(PLL_PERIOD_MAX,Math.max(PLL_PERIOD_MIN,s.period));
s.locked+=(Math.max(0,Math.min(1,1-Math.abs(e)*3))-s.locked)*PLL_LOCK_RISE}
else{s.locked*=Math.exp(-dt/PLL_LOCK_TAU)}
return onset}
function pulseShape(ph){return ph<0.04?ph/0.04:Math.exp(-(ph-0.04)*6.5)}
function beatPulse(s,depth){if(depth<=0)return 0;return depth*PULSE_GAIN*pulseShape(s.phase)*(0.55+0.45*s.locked)}
window.BeatPll={createBeatPll,pllStep,beatPulse,expandKick,speedBoostGain,BEAT_TAU,BEAT_DEPTH_DEFAULT,INK_PULSE};
})();
