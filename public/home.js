import {LBL,GRP,ENTSPT,EUROPE,QUICK,cname} from './taxonomy.js';
import {P,savePrefs,openGeo,openInterests,toggleInterest,tune,esc} from './app.js';
const $=s=>document.querySelector(s),
safe=u=>/^https?:\/\//i.test(u)?esc(u):'#',
ago=d=>{const h=(Date.now()-new Date(d))/36e5;return h<1?Math.max(1,Math.round(h*60))+'m ago':h<24?Math.round(h)+'h ago':Math.round(h/24)+'d ago'},
hash=s=>{let h=5381;for(const c of s)h=((h*33)^c.charCodeAt(0))>>>0;return h},
short=(s,n)=>s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s,
meta=a=>esc(a.s)+' · '+ago(a.d)+(a.n>1?' · '+a.n+' sources':''),
nxt=()=>{const n=new Date(),x=Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate(),Math.floor(n.getUTCHours()/6)*6+6,7);return Math.max(1,Math.round((x-n)/36e5))},
BASE=['startups','ai','tech','business','markets','fintech','msme','india','policy','world','science','auto','health','climate','trending','sports','media'],
OP=['Signal over noise','Read less, know more','Fifteen minutes, zero noise','Start the day ahead of the room','The few things worth your attention','Clarity before the first meeting','Decide with better information','Your edge, curated daily','Context first, headlines second','Built for people who make decisions'],
WHY={biz:'Watch how funding, pricing, hiring and customer demand respond over the coming weeks.',pol:'Watch official statements, regulation and the second-order effects on markets and businesses.',sci:'Watch for the next data release, trial or paper that confirms or challenges this.',ind:'Watch sales, plant, supply-chain and pricing signals across the industry.',life:'Watch how consumers and brands respond next.',ent:'Watch how audiences, rights-holders and sponsors respond next.',spt:'Watch the next fixtures, results and rankings this changes.'},
FALL=['trending','business','tech','world','policy','science'],
NOT=new Set('the,why,how,what,when,who,after,new,says,say,this,that,here,live,top,monday,tuesday,wednesday,thursday,friday,saturday,sunday,india,indian,us,uk,ai,report,reports'.split(',')),
hreg=g=>g==='IN'?'IN':g==='US'?'US':(g==='EU'||EUROPE.has(g))?'EU':'GL',
geo=a=>a.r==='GL'||P.geos.some(g=>hreg(g)===a.r)||(a.r==='IN'&&P.sel.includes('india')),
lnk=a=>`href="${safe(a.u)}" target="_blank" rel="noopener noreferrer"`,
row=(e,big)=>{const a=e.a;return `<a class="row" ${lnk(a)}>${big&&a.i?`<img src="${esc(a.i)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:''}<div><h4 class="serif">${esc(a.t)}</h4>${big&&a.x?`<p>${esc(short(a.x,170))}</p>`:''}<small>${meta(a)}</small></div></a>`};
let D=[],GEN=Date.now(),stage=1,more=false,ready=false;const WK={};

function build(){
 const ids=P.sel.length>=6?P.sel:[...P.sel,...FALL.filter(x=>!P.sel.includes(x))].slice(0,6),best=new Map();
 for(const a of D)if(geo(a)){const b=best.get(a.c);if(!b||a.q>b.q)best.set(a.c,a)}
 const rep=[...best.values()],sc=a=>a.q*(1+.12*a.k.filter(k=>ids.includes(k)).length),
 pools=ids.map((id,i)=>({id,i,n:0,l:rep.filter(a=>a.k.includes(id)&&(ENTSPT.has(id)||!ENTSPT.has(a.k[0]))).sort((x,y)=>sc(y)-sc(x))})),
 seen=new Set(),L=[];
 for(let r=0;r<10;r++)for(const p of pools){while(p.n<p.l.length&&seen.has(p.l[p.n].c))p.n++;const a=p.l[p.n];if(a){seen.add(a.c);L.push({a,id:p.id,i:p.i,s:sc(a)});p.n++}}
 return{ids,L}}

const ent=its=>{const f={};for(const x of its)for(const m of x.t.matchAll(/\b[A-Z][A-Za-z0-9&.'-]*(?:\s[A-Z][A-Za-z0-9&.'-]*){0,2}/g)){const w=m[0].replace(/^(The|A|An|Why|How|What|After|As)\s/,'');if(w.length>2&&!NOT.has(w.toLowerCase()))f[w]=(f[w]||0)+w.split(' ').length}return Object.entries(f).sort((a,b)=>b[1]-a[1])[0]?.[0]||''};
async function bg(its,cid){
 const set=h=>{WK[cid]=h;if($('#bg'))$('#bg').innerHTML=h};
 if(WK[cid]!==undefined)return set(WK[cid]);
 const q=ent(its);let h='';
 try{if(q){const j=await(await fetch('https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts&exintro=1&explaintext=1&redirects=1&generator=search&gsrlimit=1&gsrsearch='+encodeURIComponent(q))).json(),p=Object.values(j.query.pages)[0],t=(p.extract||'').split('\n')[0];
 if(t.length>60&&q.toLowerCase().split(' ').some(w=>w.length>2&&p.title.toLowerCase().includes(w)))h=`<p>${esc(short(t,700))}</p><small>From Wikipedia — <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g,'_'))}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a> (CC BY-SA)</small>`}}catch(e){}
 set(h||'<p class="mu">No encyclopedia background was found for this story; the original sources are linked below.</p>')}

function story(e,its){
 const a=e.a,ss=new Set([a.s]),more=its.filter(x=>x!==a&&x.x&&!ss.has(x.s)&&ss.add(x.s)).slice(0,3),
 mins=Math.max(2,Math.ceil([a.x,...more.map(x=>x.x)].join(' ').split(/\s+/).length/150));
 return `<div class="kick">The Story · ${esc(LBL[e.id])}</div><h2 class="serif">${esc(a.t)}</h2>
${a.x?`<p class="dek">${esc(a.x)}</p>`:''}<small>${a.n} source${a.n>1?'s':''} · ${mins} min read · ${ago(a.d)}</small>
${a.i?`<img class="hero-img" src="${esc(a.i)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:''}
${more.length?`<h5>What we know</h5>${more.map(x=>`<p>${esc(x.x)} <em>— ${esc(x.s)}</em></p>`).join('')}`:''}
${its.length>1?`<h5>How it unfolded</h5><ol class="tl">${its.slice(-6).map(x=>`<li><b>${ago(x.d)}</b> · ${esc(x.s)}: <a ${lnk(x)}>${esc(x.t)}</a></li>`).join('')}</ol>`:''}
<h5>Background</h5><div class="bg" id="bg"><p class="mu">Gathering context…</p></div>
<h5>Why it matters to you</h5><p>${WHY[GRP[e.id]]||WHY.biz} It leads your briefing because it sits on your ${esc(LBL[e.id])} desk${a.n>1?` and ${a.n} independent outlets are covering it`:''} — filtered for ${esc(P.geos.slice(0,2).map(cname).join(' & '))}.</p>
<a class="btn" ${lnk(a)}>Read the original at ${esc(a.s)} →</a>`}

function tuneUI(pct,shown,T){
 const o=[...P.sel,...BASE.filter(x=>!P.sel.includes(x))],v=more?o:o.slice(0,7),gl=[...QUICK,...P.geos.filter(g=>!QUICK.includes(g))];
 $('#tune').innerHTML=`<h3 class="serif">Tune my briefing</h3><p class="mu">Build it around your day. Your first pick has the highest priority — tap its number to raise it.</p>
<label for="nm">Your name</label><input id="nm" maxlength="24" autocomplete="given-name" value="${esc(P.name)}" placeholder="How should we greet you?">
<label>Geography</label><div class="chips">${gl.map(g=>`<button class="chip${P.geos.includes(g)?' on':''}" data-c="${g}" aria-pressed="${P.geos.includes(g)}">${esc(cname(g))}</button>`).join('')}<button class="chip add" data-g="1">＋ Add geography</button></div>
<label>Interests · ${P.sel.length} selected</label><div class="chips">${v.map(id=>{const i=P.sel.indexOf(id);return`<button class="chip${i>=0?' on':''}" data-i="${id}" aria-pressed="${i>=0}">${i>=0?`<b title="Raise priority">${i+1}</b>`:''}${esc(LBL[id])}</button>`}).join('')}${!more&&o.length>7?`<button class="chip" data-m="1">More +${o.length-7}</button>`:'<button class="chip add" data-y="1">Your interests ›</button>'}</div>
<div class="meter"><i style="width:${pct}%"></i></div><small>${shown} of ${T} stories · ${pct}% of today’s briefing (up to 10 per interest)</small>
<button class="btn fill wide" id="tn">Tune my briefing</button><p class="err" id="te"></p>`}

function render(){
 const{ids,L}=build(),T=L.length,w=e=>e.s*(1+.15*Math.min(e.a.n,6))*(1+.3*(ids.length-e.i)/ids.length),
 rm=e=>{const i=L.indexOf(e);if(i>=0)L.splice(i,1);return e};
 const st=L.length?rm(L.slice(0,ids.length*2).reduce((m,e)=>w(e)>w(m)?e:m)):null,
 dk=ids.slice(0,9).map(id=>L.find(e=>e.id===id)).filter(Boolean).map(rm),
 fy=L.slice().sort((x,y)=>w(y)-w(x)).slice(0,5).map(rm),
 u0=dk.length+(st?1:0)+fy.length,qt=s=>Math.max(0,Math.ceil(T*s/4)-u0),show=L.slice(0,qt(stage)),
 shown=u0+show.length,pct=T?Math.round(100*shown/T):0,done=T>0&&shown>=T,
 its=st?D.filter(x=>x.c===st.a.c&&geo(x)).sort((x,y)=>new Date(x.d)-new Date(y.d)):[],
 h=new Date().getHours();
 $('#gm').textContent='Good '+(h<12?'morning':h<17?'afternoon':'evening')+(P.name?', '+P.name:'');
 $('#tg').textContent=OP[(Math.floor(Date.now()/864e5)+hash(P.name+ids[0]))%OP.length]+'.'+(dk[0]?` On your ${LBL[dk[0].id]} desk: “${short(dk[0].a.t,72)}”.`:'');
 $('#ed').textContent=ready&&D.length?'Edition updated '+ago(GEN):'';
 $('#dk').innerHTML=dk.map(e=>`<a class="tile" ${lnk(e.a)}><span class="lab">${esc(LBL[e.id])}</span><h4 class="serif">${esc(e.a.t)}</h4><small>${meta(e.a)}</small></a>`).join('');
 $('#st').hidden=!st;if(st){$('#st').innerHTML=story(st,its);bg(its,st.a.c)}
 $('#fyw').hidden=!fy.length;$('#fy').innerHTML=fy.map(e=>row(e,1)).join('');
 $('#sc').innerHTML=ids.map(id=>[id,show.filter(e=>e.id===id)]).filter(g=>g[1].length).map(([id,l])=>`<section><h3 class="sec serif">${esc(LBL[id])}<small>${l.length} stories · ${esc(P.geos.slice(0,2).map(cname).join(' & '))}</small></h3><div class="card">${l.map((e,i)=>row(e,i===0)).join('')}</div></section>`).join('');
 $('#pg').innerHTML=!T?`<div class="card">${ready?'No stories match yet — your first edition is being prepared. Please refresh in a minute.':'Preparing your briefing…'}</div>`:done?`<div class="card done" role="status">✓ You’re all caught up — your briefing is done.<br><small>The next edition arrives in about ${nxt()} hours.</small></div>`:`<button class="btn" id="more">Continue · ${pct}% of your briefing</button>`;
 if(T&&!done)$('#more').onclick=()=>{let s=stage;do s++;while(s<4&&qt(s)<=show.length);stage=s;render()};
 tuneUI(pct,shown,T)}

$('#tune').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const d=b.dataset;
 if(d.g)return openGeo(()=>{stage=1;render()});
 if(d.y)return openInterests(()=>{more=false;stage=1;render()});
 if(d.c){const i=P.geos.indexOf(d.c);if(i>=0){if(P.geos.length>1)P.geos.splice(i,1)}else P.geos.push(d.c)}
 else if(d.m)more=true;
 else if(d.i)toggleInterest(d.i,e.target.tagName==='B');
 else if(b.id==='tn'){$('#te').textContent=tune();return}
 else return;
 stage=1;savePrefs();render()});
$('#tune').addEventListener('change',e=>{if(e.target.id==='nm'){P.name=e.target.value.trim().slice(0,24);savePrefs();render()}});
document.addEventListener('bs:prefs',()=>{stage=1;render()});

const n=new Date();
$('#dt').textContent=n.toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
render();
// Live teaser from the Worker first, the static file as a backup, so a broken or stale file can never blank the homepage.
const loadFeed=async()=>{for(const url of['/api/teaser','feed.json']){try{const r=await fetch(url);if(!r.ok)continue;const j=await r.json(),items=(j.items||[]).filter(a=>a&&a.t&&a.u&&a.c&&Array.isArray(a.k));if(items.length)return{items,gen:j.gen}}catch{}}return null};
loadFeed().then(j=>{if(j){D=j.items;GEN=j.gen||Date.now()}}).then(()=>{ready=true;render()});
