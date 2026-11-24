import {LBL,ENTSPT,EUROPE,QUICK,cname} from './taxonomy.js';
import {P,savePrefs,openGeo,openInterests,toggleInterest,tune,esc,openAuth} from './app.js';
import {plural,cleanHeadline,dropRepeats,sentences,hostOf} from './textfmt.js';
import {shareHTML} from './chrome.js';
import './peek.js';
const $=s=>document.querySelector(s),
safe=u=>/^https?:\/\//i.test(u)?esc(u):'#',
ago=d=>{const h=(Date.now()-new Date(d))/36e5;return h<1?Math.max(1,Math.round(h*60))+'m ago':h<24?Math.round(h)+'h ago':Math.round(h/24)+'d ago'},
hash=s=>{let h=5381;for(const c of s)h=((h*33)^c.charCodeAt(0))>>>0;return h},
short=(s,n)=>s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s,
// Small source logo: the site's own icon (through our own server, so no third party sees your visit) over a letter badge that shows while it loads or if there is none.
logo=a=>{const d=a.lg||(/news\.google\./.test(a.u)?'':hostOf(a.u));return `<span class="lg" aria-hidden="true">${esc((a.s||'?').trim().charAt(0).toUpperCase())}${d?`<img src="/api/logo?d=${encodeURIComponent(d)}" alt="" width="16" height="16" loading="lazy" decoding="async" data-fb>`:''}</span>`},
meta=a=>logo(a)+esc(a.s)+' · '+ago(a.d)+(a.n>1?' · '+plural(a.n,'source'):''),
nxt=()=>{const n=new Date(),x=Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate(),Math.floor(n.getUTCHours()/6)*6+6,7);return Math.max(1,Math.round((x-n)/36e5))},
BASE=['startups','ai','tech','business','markets','fintech','msme','india','policy','world','science','auto','health','climate','trending','sports','media'],
OP=['Signal over noise','Read less, know more','Fifteen minutes, zero noise','Start the day ahead of the room','The few things worth your attention','Clarity before the first meeting','Decide with better information','Your edge, curated daily','Context first, headlines second','Built for people who make decisions'],
FALL=['trending','business','tech','world','policy','science'],
hreg=g=>g==='IN'?'IN':g==='US'?'US':(g==='EU'||EUROPE.has(g))?'EU':'GL',
geo=a=>a.r==='GL'||P.geos.some(g=>hreg(g)===a.r)||(a.r==='IN'&&P.sel.includes('india')),
lnk=a=>`href="${safe(a.u)}" target="_blank" rel="noopener noreferrer"`,
pk=a=>a.y?` data-pk-t="${esc(a.t)}" data-pk-y="${esc(a.y)}" data-pk-s="${esc(a.s)}" data-pk-u="${safe(a.u)}"`:'',
row=(e,big)=>{const a=e.a;return `<a class="row" ${lnk(a)}${pk(a)}>${big&&a.i?`<img src="${esc(a.i)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:''}<div><h4 class="serif">${esc(a.t)}</h4>${big&&a.x?`<p>${esc(short(a.x,170))}</p>`:''}<small>${meta(a)}</small></div></a>`};
let D=[],GEN=Date.now(),stage=1,more=false,ready=false,MK=[];
// A logo that cannot be loaded simply disappears and the letter badge stays.
document.addEventListener('error',e=>{const t=e.target;if(t&&t.tagName==='IMG'&&t.hasAttribute('data-fb'))t.remove()},true);

function build(){
 const ids=P.sel.length>=6?P.sel:[...P.sel,...FALL.filter(x=>!P.sel.includes(x))].slice(0,6),best=new Map();
 for(const a of D)if(geo(a)){const b=best.get(a.c);if(!b||a.q>b.q)best.set(a.c,a)}
 const rep=[...best.values()],sc=a=>a.q*(1+.12*a.k.filter(k=>ids.includes(k)).length),
 pools=ids.map((id,i)=>({id,i,n:0,l:rep.filter(a=>a.k.includes(id)&&(ENTSPT.has(id)||!ENTSPT.has(a.k[0]))).sort((x,y)=>sc(y)-sc(x))})),
 seen=new Set(),L=[];
 for(let r=0;r<10;r++)for(const p of pools){while(p.n<p.l.length&&seen.has(p.l[p.n].c))p.n++;const a=p.l[p.n];if(a){seen.add(a.c);L.push({a,id:p.id,i:p.i,s:sc(a)});p.n++}}
 return{ids,L}}

// The free top story: what happened in up to three short points, then one line on why it matters. Both come from the AI summary of the story.
function story(e){
 const a=e.a,pts=sentences(a.y||'').slice(0,3).map(s=>short(s,200)),signedIn=!!window.BSAuth?.has?.();
 return `<div class="kick">Today’s top story · ${esc(LBL[e.id])}<span class="free">Free full summary</span></div><h2 class="serif">${esc(a.t)}</h2>
<div class="src">${meta(a)}</div>
${pts.length?`<h5>What happened</h5><ul class="pts">${pts.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:''}
${a.w?`<h5>Why it matters</h5><p class="why">${esc(a.w)}</p>`:''}
<div class="stfoot"><a class="btn fill" ${lnk(a)}>Read the full story at ${esc(a.s)} ↗</a>${shareHTML(a.t,a.u)}</div>
<p class="upsell">${signedIn?'<a class="link" href="#/me/read">Open my briefing →</a>':'This is one free summary a day. Want every story summarised and ranked for you? <button class="link" type="button" data-start>Start your 7-day free trial</button>'}</p>`}

// One interest chip. A picked interest shows its rank and a clear "move up" arrow; the first one is marked as the top pick.
const chip=(id,i)=>i<0?`<button class="chip" data-i="${id}" aria-pressed="false">${esc(LBL[id])}</button>`
 :`<span class="cw"><button class="chip on" data-i="${id}" aria-pressed="true"><b>${i+1}</b>${esc(LBL[id])}</button>${i>0?`<button class="up" data-up="${id}" type="button" aria-label="Move ${esc(LBL[id])} up" title="Move up">↑</button>`:'<span class="top1" title="Your top pick gets the most stories">Top</span>'}</span>`;

function tuneUI(pct,shown,T){
 const o=[...P.sel,...BASE.filter(x=>!P.sel.includes(x))],v=more?o:o.slice(0,7),gl=[...QUICK,...P.geos.filter(g=>!QUICK.includes(g))];
 $('#tune').innerHTML=`<button class="xs" type="button" id="xs" aria-label="Close">×</button><h3 class="serif">Personalise your briefing</h3><p class="mu help">Choose what you want to read. Your top pick gets the most stories. Tap ↑ on an interest to move it higher.</p>
<label for="nm">Your name</label><input id="nm" maxlength="24" autocomplete="given-name" value="${esc(P.name)}" placeholder="How should we greet you?">
<label>Region</label><div class="chips">${gl.map(g=>`<button class="chip${P.geos.includes(g)?' on':''}" data-c="${g}" aria-pressed="${P.geos.includes(g)}">${esc(cname(g))}</button>`).join('')}<button class="chip add" data-g="1">＋ Add region</button></div>
<label>Interests · ${P.sel.length} selected</label><div class="chips">${v.map(id=>chip(id,P.sel.indexOf(id))).join('')}${!more&&o.length>7?`<button class="chip" data-m="1">More +${o.length-7}</button>`:'<button class="chip add" data-y="1">All interests ›</button>'}</div>
<div class="meter"><i style="width:${pct}%"></i></div><small>${plural(shown,'story','stories')} of ${T} · ${pct}% of today’s briefing (up to 10 per interest)</small>
<button class="btn fill wide" id="tn">Build my personal briefing</button><p class="err" id="te"></p>`}

function cta(){
 const signedIn=!!window.BSAuth?.has?.();
 $('#cta').innerHTML=signedIn?'<a class="btn fill" href="#/me/read">Open my briefing</a><button class="btn pz" type="button" id="pz">Personalise</button>'
  :'<button class="btn fill" type="button" data-start>Start free</button><a class="btn hide-sm" href="/pricing">See pricing</a><button class="btn pz" type="button" id="pz">Personalise</button><span class="mu">7 days free · no card needed · cancel any time</span>'}

function render(){
 const{ids,L}=build(),T=L.length,w=e=>e.s*(1+.15*Math.min(e.a.n,6))*(1+.3*(ids.length-e.i)/ids.length),
 rm=e=>{const i=L.indexOf(e);if(i>=0)L.splice(i,1);return e};
 // The top story is the strongest one that has an AI summary, so the free card always has something to read.
 const pool=L.slice(0,ids.length*2),withSummary=pool.filter(e=>e.a.y),pick=withSummary.length?withSummary:pool,
 st=pick.length?rm(pick.reduce((m,e)=>w(e)>w(m)?e:m)):null,
 dk=ids.slice(0,9).map(id=>L.find(e=>e.id===id)).filter(Boolean).map(rm),
 fy=L.slice().sort((x,y)=>w(y)-w(x)).slice(0,5).map(rm),
 u0=dk.length+(st?1:0)+fy.length,qt=s=>Math.max(0,Math.ceil(T*s/4)-u0),show=L.slice(0,qt(stage)),
 shown=u0+show.length,pct=T?Math.round(100*shown/T):0,done=T>0&&shown>=T,
 h=new Date().getHours();
 $('#gm').textContent='Good '+(h<12?'morning':h<17?'afternoon':'evening')+(P.name?', '+P.name:'');
 $('#tg').textContent=OP[(Math.floor(Date.now()/864e5)+hash(P.name+ids[0]))%OP.length]+'.'+(dk[0]?` On your ${LBL[dk[0].id]} desk: “${short(dk[0].a.t,72)}”.`:'');
 $('#ed').textContent=ready&&D.length?'Edition updated '+ago(GEN):'';
 cta();
 $('#dk').innerHTML=dk.map(e=>`<a class="tile" ${lnk(e.a)}${pk(e.a)}><span class="lab">${esc(LBL[e.id])}</span><h4 class="serif">${esc(e.a.t)}</h4><small>${meta(e.a)}</small></a>`).join('');
 $('#st').hidden=!st;if(st)$('#st').innerHTML=story(st);
 $('#fyw').hidden=!fy.length;$('#fy').innerHTML=fy.map(e=>row(e,1)).join('');
 $('#sc').innerHTML=ids.map(id=>[id,show.filter(e=>e.id===id)]).filter(g=>g[1].length).map(([id,l])=>`<section><h3 class="sec serif">${esc(LBL[id])}<small>${plural(l.length,'story','stories')} · ${esc(P.geos.slice(0,2).map(cname).join(' & '))}</small></h3><div class="card">${l.map((e,i)=>row(e,i===0)).join('')}</div></section>`).join('');
 // The progress bar stays in the page itself, so it is always visible (the settings are behind the Personalise button on phones).
 const bar=`<div class="meter" role="img" aria-label="${pct}% of today’s briefing"><i style="width:${pct}%"></i></div>`;
 $('#pg').innerHTML=!T?`<div class="card">${ready?'No stories match yet — your first edition is being prepared. Please refresh in a minute.':'Preparing your briefing…'}</div>`:done?`${bar}<div class="card done" role="status">✓ You’re all caught up — your briefing is done.<br><small>The next edition arrives in about ${plural(nxt(),'hour')}.</small></div>`:`${bar}<button class="btn" id="more">Continue · ${pct}% of your briefing</button>`;
 if(T&&!done)$('#more').onclick=()=>{let s=stage;do s++;while(s<4&&qt(s)<=show.length);stage=s;render()};
 tuneUI(pct,shown,T);drawMarkets()}

$('#tune').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const d=b.dataset;
 if(b.id==='xs'){document.body.classList.remove('tuning');return}
 if(d.g)return openGeo(()=>{stage=1;render()});
 if(d.y)return openInterests(()=>{more=false;stage=1;render()});
 if(d.c){const i=P.geos.indexOf(d.c);if(i>=0){if(P.geos.length>1)P.geos.splice(i,1)}else P.geos.push(d.c)}
 else if(d.m)more=true;
 else if(d.up)toggleInterest(d.up,true);
 else if(d.i)toggleInterest(d.i,false);
 else if(b.id==='tn'){document.body.classList.remove('tuning');$('#te').textContent=tune();return}
 else return;
 stage=1;savePrefs();render()});
$('#tune').addEventListener('change',e=>{if(e.target.id==='nm'){P.name=e.target.value.trim().slice(0,24);savePrefs();render()}});
document.addEventListener('click',e=>{if(e.target.closest?.('#pz')){document.body.classList.add('tuning');scrollTo(0,0)}});
addEventListener('keydown',e=>{if(e.key==='Escape')document.body.classList.remove('tuning')});
document.addEventListener('bs:prefs',()=>{stage=1;render()});
document.addEventListener('bs:auth',()=>render());

// ---- markets (Sensex, Nifty, Nasdaq...): a card beside the news on a computer, a swipeable strip on a phone. Hidden if the data is unavailable.
const num=(v,d)=>Number(v).toLocaleString(hreg(P.geos[0]||'US')==='IN'?'en-IN':'en-US',{minimumFractionDigits:d,maximumFractionDigits:d}),
mrow=m=>{const d=m.decimals??(m.price<100?2:0),up=m.pct>=0;return{n:esc(m.name),p:num(m.price,d),c:`<span class="${up?'up-c':'dn-c'}">${up?'▲':'▼'} ${Math.abs(m.pct).toFixed(2)}%</span>`}};
function drawMarkets(){
 if(!MK.length)return;
 const first=hreg(P.geos[0]||'US'),list=[...MK].sort((a,b)=>(b.region===first)-(a.region===first)).map(mrow);
 $('#mk').innerHTML=`<h3 class="serif">Markets</h3><ul>${list.map(m=>`<li><b>${m.n}</b><span class="n">${m.p}<small>${m.c}</small></span></li>`).join('')}</ul><p class="src mu">Delayed quotes · Yahoo Finance</p>`;$('#mk').hidden=false;
 $('#mkm').innerHTML=list.slice(0,5).map(m=>`<div><b>${m.n}</b>${m.p} ${m.c}</div>`).join('');$('#mkm').hidden=false}
fetch('/api/markets').then(r=>r.ok?r.json():null).then(j=>{if(j?.items?.length){MK=j.items;drawMarkets()}}).catch(()=>{});

const n=new Date();
$('#dt').textContent=n.toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
{const q=new URLSearchParams(location.search);   // links such as /?start=1 (from the other pages) open the sign-up box
 if((q.has('start')||q.has('signin'))&&!window.BSAuth?.has?.()){const up=q.has('start');history.replaceState(null,'',location.pathname+location.hash);
  setTimeout(()=>openAuth(up?'Start your 7-day free trial. No card needed.':'Sign in to open your personal briefing, or create a free account in seconds.',up?'up':'in'),0)}}
render();
// Live teaser from the Worker first, the static file as a backup, so a broken or stale file can never blank the homepage.
// Every headline gets the same style, and the same story told twice is shown once.
const loadFeed=async()=>{for(const url of['/api/teaser','feed.json']){try{const r=await fetch(url);if(!r.ok)continue;const j=await r.json(),items=(j.items||[]).filter(a=>a&&a.t&&a.u&&a.c&&Array.isArray(a.k)).map(a=>({...a,t:cleanHeadline(a.t,a.s)}));
 if(items.length)return{items:dropRepeats(items.sort((x,y)=>(y.q||0)-(x.q||0))),gen:j.gen}}catch{}}return null};
loadFeed().then(j=>{if(j){D=j.items;GEN=j.gen||Date.now()}}).then(()=>{ready=true;render();if(D.length)document.getElementById('seo-news')?.remove()});
