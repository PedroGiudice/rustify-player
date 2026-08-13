/* renderers.js — porta 1:1 de src/renderers.ts (mesh/columns/weave/dots/contour).
   Assinatura: (ctx,w,h,t,shapeFn,amp,breath,ink,env,inkBoost) */
(function(){
const NLINES=110,NPOINTS=96,NCOLS=90,NROWS=110,NBANDS=34;
function drawMesh(ctx,w,h,t,shapeFn,amp,_breath,ink,_env,style){
const topY=h*0.04,botY=h*0.98;ctx.beginPath();
for(let i=0;i<NLINES;i++){const v=i/(NLINES-1),baselineY=topY+(botY-topY)*v;
for(let j=0;j<=NPOINTS;j++){const u=j/NPOINTS,x=u*w,s=shapeFn(u,v,t),
phase=i*0.085+t*0.55,wave=Math.sin(u*Math.PI*3.2+phase)*s*amp,drift=Math.sin(t*0.45+i*0.07)*1.4,y=baselineY-wave+drift;
if(j===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}}
ctx.strokeStyle=(style&&style.color)||`rgba(${ink}, 0.16)`;ctx.lineWidth=(style&&style.width)||0.7;ctx.stroke()}
function drawColumns(ctx,w,h,t,shapeFn,amp,_breath,ink,_env,style){
const leftX=w*0.02,rightX=w*0.98;ctx.beginPath();
for(let i=0;i<NCOLS;i++){const u=i/(NCOLS-1),baselineX=leftX+(rightX-leftX)*u;
for(let j=0;j<=NROWS;j++){const v=j/NROWS,y=h*0.04+h*0.94*v,s=shapeFn(u,v,t),
phase=i*0.085+t*0.55,wave=Math.sin(v*Math.PI*3.2+phase)*s*amp,drift=Math.sin(t*0.45+i*0.07)*1.4,x=baselineX-wave+drift;
if(j===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}}
ctx.strokeStyle=(style&&style.color)||`rgba(${ink}, 0.16)`;ctx.lineWidth=(style&&style.width)||0.7;ctx.stroke()}
function drawWeave(ctx,w,h,t,shapeFn,amp,breath,ink,env){
drawMesh(ctx,w,h,t,shapeFn,amp*0.8,breath,ink,env,{color:`rgba(${ink}, 0.10)`,width:0.6});
drawColumns(ctx,w,h,t,shapeFn,amp*0.8,breath,ink,env,{color:`rgba(${ink}, 0.10)`,width:0.6})}
function drawDots(ctx,w,h,t,shapeFn,_amp,breath,ink,env){
const gx=Math.max(12,Math.round(w/7.5)),gy=Math.max(12,Math.round(h/7.5));
const maxR=Math.min(w/gx,h/gy)*0.72,e=Math.min(1,Math.max(0,env));
ctx.fillStyle=`rgb(${ink})`;
for(let iy=0;iy<gy;iy++){const v=iy/(gy-1),y=h*0.04+h*0.94*v;
for(let ix=0;ix<gx;ix++){const u=ix/(gx-1),s=shapeFn(u,v,t);
if(s<0.03)continue;
const cl=Math.min(1,s),pulse=1+0.6*e*cl,r=maxR*cl*(0.55+0.45*breath)*pulse,x=u*w+Math.sin(t*0.6+iy*0.3)*1.2;
ctx.globalAlpha=Math.min(0.95,(0.10+0.55*cl)*(1+0.9*e));
ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill()}}
ctx.globalAlpha=1}
function drawContour(ctx,w,h,t,shapeFn,amp,_breath,ink,_env,inkBoost){
const topY=h*0.04,botY=h*0.98,boost=inkBoost||1;
for(let i=0;i<NBANDS;i++){const v=i/(NBANDS-1),baselineY=topY+(botY-topY)*v;let peak=0;ctx.beginPath();
for(let j=0;j<=NPOINTS;j++){const u=j/NPOINTS,x=u*w,s=shapeFn(u,v,t);
if(s>peak)peak=s;
const wave=Math.sin(u*Math.PI*3.2+t*0.55)*s*amp*1.5,y=baselineY-wave;
if(j===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}
const a=Math.min(0.9,(0.05+0.32*peak)*boost);
ctx.strokeStyle=`rgba(${ink}, ${a})`;ctx.lineWidth=0.6+1.6*peak;ctx.stroke()}}
window.RENDERERS=[
{name:"mesh",fn:(ctx,w,h,t,sf,amp,br,ink,env)=>drawMesh(ctx,w,h,t,sf,amp,br,ink,env)},
{name:"columns",fn:(ctx,w,h,t,sf,amp,br,ink,env)=>drawColumns(ctx,w,h,t,sf,amp,br,ink,env)},
{name:"weave",fn:drawWeave},
{name:"dots",fn:drawDots},
{name:"contour",fn:drawContour}];
})();
