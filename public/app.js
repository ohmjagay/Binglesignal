// BingleSignal app layer: preferences, pickers, sign-in, personal READ / WATCH feeds and the ranking engine.
import {CATS,CAT,GROUPS,LBL,CC,ISO,EUROPE,cname} from './taxonomy.js';
const BS=window.BS||{},$=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safe=u=>/^https?:\/\//i.test(u)?esc(u):'#',short=(s,n)=>s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s,
ago=t=>{const h=(Date.now()-t)/36e5;return h<1?Math.max(1,Math.round(h*60))+'m ago':h<24?Math.round(h)+'h ago':Math.round(h/24)+'d ago'},
fmt=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n|0),
hash=s=>{let h=5381;for(const c of s)h=((h*33)^c.charCodeAt(0))>>>0;return h},
store={get(k){try{return JSON.parse(localStorage.getItem(k))}catch{return null}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}},del(k){try{localStorage.removeItem(k)}catch{}}};

/* ---------- declared preferences (what the reader tells us) ---------- */
const tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'',
dGeo=/Kolkata|Calcutta/.test(tz)?'IN':/^America\//.test(tz)?'US':/London/.test(tz)?'GB':/Berlin/.test(tz)?'DE':/^Europe\//.test(tz)?'EU':'US';
export const defSel=g=>['startups','ai','tech','business',g==='IN'?'india':'world','policy','science','trending'];
export const P=Object.assign({name:'',geos:null,sel:null,ts:0},store.get('bs3')||{});
if(!Array.isArray(P.geos))P.geos=P.region&&P.region!=='GL'?[P.region]:[dGeo];delete P.region;
P.geos=P.geos.filter((x,i,a)=>(x==='EU'||ISO.has(x))&&a.indexOf(x)===i);if(!P.geos.length)P.geos=[dGeo];
P.sel=(Array.isArray(P.sel)?P.sel:defSel(P.geos[0])).filter((x,i,a)=>LBL[x]&&a.indexOf(x)===i);
P.name=String(P.name||'').slice(0,24);
export const savePrefs=()=>{P.ts=Date.now();store.set('bs3',P);push()};
export function toggleInterest(id,raise){const i=P.sel.indexOf(id);if(raise){if(i>0)[P.sel[i-1],P.sel[i]]=[P.sel[i],P.sel[i-1]]}else if(i>=0)P.sel.splice(i,1);else P.sel.push(id)}

/* ---------- learned model (what we learn from behaviour) ---------- */
// four prediction heads share one feature vector: click, like, save, skip. Utility = weighted sum (like TikTok-style multi-objective ranking)
const W0={c:[-5,3,2.2,.8,.9,.7,1.2,.7,.5],l:[-5.6,2.8,2.2,.5,.9,.6,.5,.7,.6],s:[-6.2,2.4,2.4,.4,.5,.9,.1,.5,.6],k:[-1.2,-2.2,-1.6,-.3,-.2,-.2,.1,-.5,-.3]},V={c:1,l:2,s:3,k:-1.6};
const PR=Object.assign({c:{},w:{},s:{},n:0,W:null,hid:[],lk:[],sv:[],seen:{},ts:0,at:Date.now()},store.get('bs4')||{});
if(!PR.W||Object.keys(W0).some(h=>!PR.W[h]||PR.W[h].length!==9))PR.W=JSON.parse(JSON.stringify(W0));
{const d=(Date.now()-PR.at)/864e5;if(d>.5){const f=.97**d;for(const m of[PR.c,PR.w])for(const k in m)m[k]*=f}PR.at=Date.now()}
let ps;const persist=()=>{PR.ts=Date.now();clearTimeout(ps);ps=setTimeout(()=>store.set('bs4',PR),400);push()};
addEventListener('pagehide',()=>store.set('bs4',PR));

/* ---------- sign-in (Supabase REST, no libraries) ---------- */
const SB=BS.supabaseUrl,KEY=BS.supabaseKey;let S=store.get('bs_sess'),pt;
async function api(path,o={}){let r;try{r=await fetch(SB+path,{method:o.m||'GET',headers:{apikey:KEY,'Content-Type':'application/json',...(o.t?{Authorization:'Bearer '+o.t}:{}),...(o.h||{})},body:o.b?JSON.stringify(o.b):undefined})}catch{throw new Error('Network problem - please check your connection and try again.')}
 let j=null;try{j=await r.json()}catch{}
 if(!r.ok)throw new Error(j?.msg||j?.error_description||j?.message||j?.error||'Something went wrong ('+r.status+')');return j}
function setSess(j){S={at:j.access_token,rt:j.refresh_token,exp:Date.now()+(+j.expires_in||3600)*1000,u:j.user||S?.u||null};store.set('bs_sess',S);paintHs();return S}
function drop(){S=null;store.del('bs_sess');paintHs()}
async function token(){if(!S)return null;if(Date.now()>S.exp-60000){try{setSess(await api('/auth/v1/token?grant_type=refresh_token',{m:'POST',b:{refresh_token:S.rt}}))}catch{drop();return null}}return S.at}
async function loadUser(){const t=await token();if(!t)return;S.u=await api('/auth/v1/user',{t});store.set('bs_sess',S);const n=S.u?.user_metadata?.full_name;if(!P.name&&n){P.name=n.split(' ')[0].slice(0,24);savePrefs()}}
async function signUp(email,password,name){const j=await api('/auth/v1/signup',{m:'POST',b:{email,password,data:{full_name:name||email.split('@')[0]}}});return j.access_token?setSess(j):null}
const signIn=async(email,password)=>setSess(await api('/auth/v1/token?grant_type=password',{m:'POST',b:{email,password}}));
const google=()=>{location.href=SB+'/auth/v1/authorize?provider=google&redirect_to='+encodeURIComponent(location.origin+'/')};
function fromHash(){const h=new URLSearchParams(location.hash.slice(1));
 if(h.get('access_token')){setSess({access_token:h.get('access_token'),refresh_token:h.get('refresh_token'),expires_in:h.get('expires_in')});history.replaceState(null,'',location.pathname+location.search);return'ok'}
 if(h.get('error')){history.replaceState(null,'',location.pathname+location.search);return h.get('error_description')||h.get('error')}return''}
function push(){clearTimeout(pt);pt=setTimeout(async()=>{const t=await token();if(!t||!S?.u)return;try{await api('/rest/v1/bs_profiles?on_conflict=id',{m:'POST',t,h:{Prefer:'resolution=merge-duplicates,return=minimal'},b:{id:S.u.id,data:{d:P,l:PR},updated_at:new Date().toISOString()}})}catch{}},1500)}
async function pull(){const t=await token();if(!t||!S?.u)return false;try{const r=await api('/rest/v1/bs_profiles?select=data&id=eq.'+S.u.id,{t}),d=r[0]?.data;
 if(d?.d&&Math.max(d.d.ts||0,d.l?.ts||0)>Math.max(P.ts||0,PR.ts||0)){Object.assign(P,d.d);Object.assign(PR,d.l||{});store.set('bs3',P);store.set('bs4',PR);return true}push()}catch{}return false}
async function entered(){try{await loadUser()}catch{}closeModal();await pull();const same=location.hash==='#/me/read';location.hash='#/me/read';if(same)route();document.dispatchEvent(new Event('bs:prefs'))}
async function out(){const t=S?.at;try{if(t)await api('/auth/v1/logout',{m:'POST',t})}catch{}drop();const same=location.hash==='#/';location.hash='#/';if(same)route()}

/* ---------- modals ---------- */
let onClose=null;
function modal(html,cls=''){const m=$('#modal');onClose=null;m.onclick=null;m.onkeydown=null;m.className='mod '+cls;m.innerHTML=`<div role="dialog" aria-modal="true"><button class="x" aria-label="Close">×</button>${html}</div>`;m.hidden=false;document.body.style.overflow='hidden';return m}
function closeModal(){const m=$('#modal');if(m.hidden)return;m.hidden=true;m.innerHTML='';document.body.style.overflow='';const f=onClose;onClose=null;f?.()}
$('#modal').addEventListener('click',e=>{if(e.target.id==='modal'||e.target.closest('.x'))closeModal()});
addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});

export function openGeo(done){
 const all=['EU',...CC.split(' ')].map(c=>[c,cname(c)]).sort((a,b)=>a[1].localeCompare(b[1])),
 m=modal(`<h2 class="serif">Add geography</h2><p class="mu">Choose every country or region you want stories from. Your first choice is your home.</p><input id="gq" placeholder="Search countries…" autocomplete="off"><div class="chips" id="gl"></div><button class="btn fill wide" id="gd">Done</button>`,'big'),
 draw=()=>{const q=$('#gq').value.trim().toLowerCase();$('#gl').innerHTML=all.filter(([,n])=>n.toLowerCase().includes(q)).map(([c,n])=>`<button class="chip${P.geos.includes(c)?' on':''}" data-c="${c}" aria-pressed="${P.geos.includes(c)}">${esc(n)}</button>`).join('')};
 draw();$('#gq').oninput=draw;
 m.onclick=e=>{const b=e.target.closest('[data-c]');if(b){const c=b.dataset.c,i=P.geos.indexOf(c);if(i>=0){if(P.geos.length>1)P.geos.splice(i,1)}else P.geos.push(c);draw()}else if(e.target.id==='gd')closeModal()};
 onClose=()=>{savePrefs();done?.()}}

const ichip=id=>{const i=P.sel.indexOf(id);return`<button class="chip${i>=0?' on':''}" data-i="${id}" aria-pressed="${i>=0}">${i>=0?`<b title="Raise priority">${i+1}</b>`:''}${esc(LBL[id])}</button>`};
export function openInterests(done){
 const m=modal(`<h2 class="serif">Your interests</h2><p class="mu">Everything we can serve. Tap to add or remove. Your order is your priority - tap a number to raise it.</p><input id="iq" placeholder="Search interests…" autocomplete="off"><div id="il"></div><button class="btn fill wide" id="id"></button>`,'big'),
 draw=()=>{const q=$('#iq').value.trim().toLowerCase();$('#il').innerHTML=Object.entries(GROUPS).map(([g,gl])=>{const cs=CATS.filter(c=>c[2]===g&&(!q||c[1].toLowerCase().includes(q)));return cs.length?`<h5>${gl}</h5><div class="chips">${cs.map(c=>ichip(c[0])).join('')}</div>`:''}).join('');$('#id').textContent='Done · '+P.sel.length+' selected'};
 draw();$('#iq').oninput=draw;
 m.onclick=e=>{const b=e.target.closest('[data-i]');if(b){toggleInterest(b.dataset.i,e.target.tagName==='B');draw()}else if(e.target.id==='id')closeModal()};
 onClose=()=>{savePrefs();done?.()}}

export function openAuth(msg,mode='up'){
 const up=mode==='up',lab=up?'Create account':'Log in',
 m=modal(`<h2 class="serif">${up?'Create your free account':'Welcome back'}</h2><p class="mu">${esc(msg||'')}</p><button class="btn gbtn" id="go">Continue with Google</button><div class="or"><span>or use email</span></div><div class="tabs"><button data-m="up" class="${up?'on':''}">Sign up</button><button data-m="in" class="${up?'':'on'}">Log in</button></div>${up?`<input id="an" placeholder="Your name" autocomplete="name" value="${esc(P.name)}">`:''}<input id="ae" type="email" placeholder="Email" autocomplete="email"><input id="ap" type="password" placeholder="Password (6+ characters)" autocomplete="${up?'new':'current'}-password"><p class="err" id="er" role="alert"></p><button class="btn fill wide" id="as">${lab}</button><small class="mu">By continuing you agree to our <a href="/privacy" target="_blank">Privacy Policy</a> and <a href="/copyright" target="_blank">Copyright notice</a>.</small>`),
 go=async()=>{const er=$('#er'),b=$('#as'),email=$('#ae').value.trim(),pw=$('#ap').value;er.style.color='';er.textContent='';
  if(!/^\S+@\S+\.\S+$/.test(email))return er.textContent='Please enter a valid email address.';
  if(pw.length<6)return er.textContent='Password must be at least 6 characters.';
  b.disabled=true;b.textContent='Please wait…';
  try{let ok;if(up){const nm=$('#an').value.trim();if(nm){P.name=nm.slice(0,24);savePrefs()}ok=await signUp(email,pw,P.name)}else ok=await signIn(email,pw);
   if(!ok){er.style.color='#CFE6D0';er.textContent='Account created. Check your email to confirm it, then log in.';b.disabled=false;b.textContent=lab;return}
   await entered()}catch(e){er.textContent=e.message;b.disabled=false;b.textContent=lab}};
 m.onclick=e=>{const t=e.target;if(t.id==='go')google();else if(t.id==='as')go();else if(t.dataset.m)openAuth(msg,t.dataset.m)};
 m.onkeydown=e=>{if(e.key==='Enter')go()};$('#ae')?.focus()}
export function tune(){if(!P.sel.length)return'Pick at least one interest first.';savePrefs();if(S){location.hash='#/me/read';return''}openAuth(`Almost there${P.name?', '+P.name:''} - create your free account to unlock your personal Read and Watch feeds.`,'up');return''}

/* ---------- header and footer ---------- */
function paintHs(){const h=$('#hs');if(h)h.innerHTML=S?'<a class="btn fill sm" href="#/me/read">My briefing</a>':'<button class="link" id="si">Sign in</button>';document.dispatchEvent(new Event('bs:auth'))}
document.addEventListener('click',e=>{if(e.target.id==='si')openAuth('Welcome back - sign in to open your personal briefing.','in')});
function paintFooter(){const f=$('#foot'),L=[];if(!f)return;if(BS.email)L.push(`<a href="mailto:${esc(BS.email)}">${esc(BS.email)}</a>`);
 const soc=(k,u,n)=>{const v=BS[k];if(v)L.push(`<a href="${/^https?:/.test(v)?esc(v):u+esc(v)}" target="_blank" rel="noopener noreferrer">${n}</a>`)};
 soc('x','https://x.com/','X');soc('linkedin','https://www.linkedin.com/company/','LinkedIn');soc('instagram','https://instagram.com/','Instagram');soc('youtube','https://youtube.com/@','YouTube');
 f.innerHTML=`<div>© ${new Date().getFullYear()} ${esc(BS.company||'BingleSignal')}. All rights reserved.</div><nav><a href="#/pricing">Pricing</a><a href="/terms">Terms</a><a href="/refund">Refunds</a><a href="/privacy">Privacy Policy</a><a href="/contact">Contact</a><a href="/copyright">Copyright</a>${L.join('')}</nav><p>Headlines, summaries and videos belong to their publishers and creators; every item links to its original source. Videos play through YouTube - by watching you agree to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a> and the <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>. Background text from Wikipedia (CC BY-SA).</p>`}

/* ---------- ranking engine ---------- */
const HL={n:14,r:20,h:16,b:48,y:96},POS=[1,.8,.65,.5,.4],PL={n:'News',r:'Reddit',h:'Hacker News',b:'Blog',y:'Video'},
STOP=new Set('this that with from have will they their about after over into more than what when your were been just also says said where which while could would there these those'.split(' ')),
toks=s=>(s.toLowerCase().match(/[a-z][a-z'-]{3,}/g)||[]).filter(w=>!STOP.has(w)),
sg=x=>1/(1+Math.exp(-x)),dot=(a,b)=>{let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s},cl=(x,a,b)=>Math.max(a,Math.min(b,x)),
rng=a=>()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296},
inGeo=(g,u)=>u==='EU'?(g==='EU'||EUROPE.has(g)):u===g;
let POOL=null;const ITEM={};
async function loadPool(){if(POOL)return POOL;try{const r=await fetch('pool.json');if(!r.ok)throw 0;POOL=await r.json();for(const i of POOL.items)ITEM[i.id]=i}catch{POOL={items:[],gen:0}}return POOL}
function geoOf(i){const hit=a=>{let b=0;for(const g of a||[])P.geos.forEach((u,j)=>{if(inGeo(g,u))b=Math.max(b,j?.85:1)});return b},s=hit(i.g),m=hit(i.m);return i.g?.length?Math.max(s,m*.8):Math.max(.7,m)}
// features: [bias, relevance (every matched interest adds, weighted by its priority: touching more interests ranks higher), coverage, geography, social proof, source quality, freshness, keyword affinity, source affinity]
function feat(i){
 const sel=P.sel,n=Math.max(1,sel.length-1);let sum=0,hit=0;
 i.k.forEach((id,j)=>{const r=sel.indexOf(id),lc=Math.tanh(PR.c[id]||0),a=(r>=0?1-.55*r/n:Math.max(0,.35*lc))*(1+.35*lc);if(r>=0)hit++;if(a>0)sum+=a*(POS[j]??.3)});
 const g=geoOf(i);if(g===0&&CAT[i.k[0]]?.[4])return null;
 let kw=0;for(const t of toks(i.t))kw+=PR.w[t]||0;const age=(Date.now()-i.d*1000)/36e5;
 return[1,1-Math.exp(-.9*sum),hit/Math.min(Math.max(sel.length,1),5),g===0?.45:g,(i.ep??30)/100,i.tr??.6,.5**(age/(HL[i.p]||24)),Math.tanh(kw/4),Math.tanh(PR.s[i.s]||0)]}
const util=(i,f)=>{const W=PR.W;let u=V.c*sg(dot(W.c,f))+V.l*sg(dot(W.l,f))+V.s*sg(dot(W.s,f))+V.k*sg(dot(W.k,f));return PR.seen[i.id]?u*.3:u};
// candidate pool -> multi-objective score -> one story per cluster -> diversity re-rank (MMR) with exploration slots
function rank(items,cap,vid){
 let C=[];for(const i of items){if(!!i.v!==vid||PR.hid.includes(i.id))continue;const f=feat(i);if(f)C.push({i,f,u:util(i,f)})}
 const best=new Map();for(const c of C){const k=vid?c.i.id:c.i.c,b=best.get(k);if(!b||c.u>b.u)best.set(k,c)}
 C=[...best.values()].sort((a,b)=>b.u-a.u);
 const mean=C.slice(0,50).reduce((s,c)=>s+c.u,0)/Math.max(1,Math.min(50,C.length)),main=C.slice(0,cap*3),
 ex=C.filter(c=>c.f[1]<.12).sort((a,b)=>b.f[4]*b.f[5]*b.f[3]-a.f[4]*a.f[5]*a.f[3]).slice(0,40),
 eps=Math.max(.06,.2*Math.exp(-PR.n/60)),rnd=rng(hash((S?.u?.id||'x')+Math.floor(Date.now()/36e5))),out=[],
 drop=(a,x)=>{const j=a.indexOf(x);if(j>=0)a.splice(j,1)};
 while(out.length<cap&&main.length){let p;
  if(out.length%6===5&&ex.length&&rnd()<eps){p=ex[Math.floor(rnd()*Math.min(ex.length,8))];p.ex=1}
  else{let bs=-1e9;for(const c of main){let pen=0;for(let q=Math.max(0,out.length-6);q<out.length;q++){const o=out[q].i;pen=Math.max(pen,(c.i.c===o.c?1:0)+(c.i.s===o.s?.35:0)+(c.i.k[0]===o.k[0]?.3:0)+(c.i.p===o.p?.08:0))}const s=c.u-.45*pen*mean;if(s>bs){bs=s;p=c}}}
  out.push(p);drop(main,p);drop(ex,p)}
 return out}
// online learning: every like / save / hide / open / skip / watch updates the four heads, topic, keyword and source affinities
function learn(i,lab,d,soft){const f=feat(i);
 if(f)for(const h in lab){const w=PR.W[h],p=sg(dot(w,f));for(let j=0;j<9;j++)w[j]+=.08*(lab[h]-p)*f[j]-.002*(w[j]-W0[h][j])}
 i.k.slice(0,3).forEach((id,j)=>{if(!soft||!P.sel.includes(id))PR.c[id]=cl((PR.c[id]||0)+d*POS[j],-3,3)});
 if(!soft)for(const t of new Set(toks(i.t)))PR.w[t]=cl((PR.w[t]||0)+d*.25,-2,2);
 PR.s[i.s]=cl((PR.s[i.s]||0)+d*(soft?.15:.4),-2,2);PR.n++;
 const ks=Object.keys(PR.w);if(ks.length>400)ks.sort((a,b)=>Math.abs(PR.w[a])-Math.abs(PR.w[b])).slice(0,100).forEach(k=>delete PR.w[k]);
 const sk=Object.keys(PR.seen);if(sk.length>1500)sk.sort((a,b)=>PR.seen[a]-PR.seen[b]).slice(0,500).forEach(k=>delete PR.seen[k]);
 persist()}

/* ---------- personal pages ---------- */
let TAB='read',READ=[],SHOWN=0,PF='all',MAXU=1,obs,sobs,SK=0,RID=0;const ACT=new Set(),VIS=new Map();
const list=()=>PF==='all'?READ:READ.filter(c=>c.i.p===PF),
chips=i=>{const g=[...(i.g||[]),...(i.m||[])].find(g=>P.geos.some(u=>inGeo(g,u))),m=i.k.filter(k=>P.sel.includes(k)).slice(0,3);return(g?`<span>${esc(cname(g))}</span>`:'')+(m.length?m:i.k.slice(0,1)).map(k=>`<span>${esc(LBL[k])}</span>`).join('')},
eng=i=>i.p==='y'?fmt(i.e||0)+' views':i.p==='r'||i.p==='h'?'▲ '+fmt(i.e||0):'';
function cardR(c){const i=c.i,n=i.k.filter(k=>P.sel.includes(k)).length,t=c.ex?'<span class="tag ex">Explore</span>':`<span class="tag mt">${n>1?'Touches '+n+' interests':'Match '+Math.max(1,Math.round(100*Math.max(0,c.u)/MAXU))+'%'}</span>`;
 return`<article class="card item" data-id="${i.id}"><div class="ct"><span class="tag">${PL[i.p]||'News'}</span><small>${esc(i.s)} · ${ago(i.d*1000)}${i.n>1?' · '+i.n+' sources':''}</small>${t}</div><a class="tt" href="${safe(i.u)}" target="_blank" rel="noopener noreferrer" data-a="open">${esc(i.t)}</a>${i.x?`<p>${esc(short(i.x,200))}</p>`:''}<div class="chips sm">${chips(i)}</div><div class="acts"><small>${eng(i)}</small><span><button data-a="like" class="${PR.lk.includes(i.id)?'on':''}">♥ Like</button><button data-a="save" class="${PR.sv.includes(i.id)?'on':''}">⚑ Save</button><button data-a="hide">✕ Less like this</button></span></div></article>`}
function cardV(c){const i=c.i;return`<div class="vc" data-id="${i.id}" data-a="vp" role="button" tabindex="0"><div class="th"><img src="https://i.ytimg.com/vi/${encodeURIComponent(i.vid)}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"><span class="pb">▶</span></div><h4>${esc(i.t)}</h4><small>${esc(i.s)} · ${fmt(i.e||0)} views · ${ago(i.d*1000)}</small><div class="chips sm">${c.ex?'<span>Explore</span>':''}${chips(i)}</div></div>`}
function shell(tab){let b=$('#home .brand')?.outerHTML||'<span class="brand serif">BingleSignal</span>';b=b.replace('id="g"','id="g2"').replace('url(#g)','url(#g2)');
 $('#app').innerHTML=`<header class="top"><div class="wrap bar"><a href="#/" aria-label="Home">${b}</a><nav class="tabs2"><a href="#/me/read" class="${tab==='read'?'on':''}">READ</a><a href="#/me/watch" class="${tab==='watch'?'on':''}">WATCH</a><a href="#/email" class="${tab==='email'?'on':''}">EMAIL BETA</a></nav><div class="hdr-r"><a class="link" href="#/account">Account</a><button class="link" data-a="ep">Preferences</button><button class="link" data-a="so">Sign out</button></div></div></header><main class="wrap" id="am"></main>`}
function summary(n,total){return`<section class="sum"><div class="eyebrow">${TAB==='read'?'Read':'Watch'} · ranked for you</div><h1 class="serif">${P.name?esc(P.name)+', your':'Your'} ${TAB==='read'?'reading list':'video queue'}</h1><div class="chips sm">${P.geos.map(g=>`<span>${esc(cname(g))}</span>`).join('')}${P.sel.slice(0,8).map(id=>`<span>${esc(LBL[id])}</span>`).join('')}${P.sel.length>8?`<span>+${P.sel.length-8} more</span>`:''}</div><small>${n} ranked from ${total} candidates · feed built ${POOL.gen?ago(POOL.gen*1000):'just now'} · it learns from every like, hide, skip and watch</small></section>`}
function empty(){return`<div class="card end">Your personal feed is being prepared. The first edition appears within a few minutes of the first automatic build - please check back shortly.</div>`}
function renderRead(){
 const cap=BS.readCap||200;READ=rank(POOL.items,cap,false);MAXU=READ[0]?.u||1;SHOWN=0;SK=0;VIS.clear();obs?.disconnect();
 if(!READ.length){$('#am').innerHTML=summary(0,0)+empty();return}
 const cnt={};READ.forEach(c=>cnt[c.i.p]=(cnt[c.i.p]||0)+1);
 $('#am').innerHTML=summary(READ.length,POOL.items.filter(i=>!i.v).length)+`<div class="pills"><button class="chip${PF==='all'?' on':''}" data-a="pf" data-k="all">All ${READ.length}</button>${Object.keys(cnt).map(k=>`<button class="chip${PF===k?' on':''}" data-a="pf" data-k="${k}">${PL[k]} ${cnt[k]}</button>`).join('')}</div><div id="rl"></div><div id="sent"></div>`;
 obs=new IntersectionObserver(es=>{for(const e of es){const id=e.target.dataset.id,i=ITEM[id];if(!i)continue;
  if(e.isIntersecting&&e.intersectionRatio>=.6){VIS.set(id,Date.now());PR.seen[id]=Date.now()}
  else if(VIS.has(id)){const d=Date.now()-VIS.get(id);VIS.delete(id);if(!ACT.has(id)&&SK<40){SK++;if(d<900)learn(i,{k:1,c:0},-.08,1);else if(d>4000)learn(i,{c:.6},.08,1)}}}},{threshold:[0,.6]});
 sobs?.disconnect();sobs=new IntersectionObserver(es=>{if(es[0].isIntersecting)more()},{rootMargin:'700px'});more();sobs.observe($('#sent'))}
function more(){const L=list(),box=$('#rl'),s=$('#sent');if(!box||!s)return;const part=L.slice(SHOWN,SHOWN+20);
 if(part.length){box.insertAdjacentHTML('beforeend',part.map(cardR).join(''));SHOWN+=part.length;part.forEach(c=>{const el=box.querySelector(`[data-id="${c.i.id}"]`);if(el)obs.observe(el)})}
 if(SHOWN>=L.length){s.innerHTML=`<div class="end">You've reached the end of today's ${L.length} ranked stories.<br>A fresh ranking arrives every 6 hours. Unlimited scrolling is coming with BingleSignal Plus.</div>`;sobs.disconnect()}
 else{s.innerHTML='<div class="end">Loading more…</div>';requestAnimationFrame(()=>{if(s.getBoundingClientRect().top<innerHeight+700)more()})}}
function renderWatch(){
 const W=rank(POOL.items,BS.watchCap||30,true);
 $('#am').innerHTML=summary(W.length,POOL.items.filter(i=>i.v).length)+(W.length?`<div class="vgrid">${W.map(cardV).join('')}</div><div class="end">Top ${W.length} videos for you. Playing a video teaches your feed what you really like.</div>`:empty())}
async function emailApi(path,method='GET',body){
 const access=await token();if(!access)throw new Error('Please sign in again.');
 const response=await fetch(path,{method,headers:{authorization:'Bearer '+access,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 let result={};try{result=await response.json()}catch{}
 if(!response.ok)throw new Error(result.error||'Email beta request failed ('+response.status+')');
 return result
}
async function renderEmailBeta(){
 const box=$('#am'),params=new URLSearchParams(location.hash.split('?')[1]||'');
 const notice=params.get('email_connected')?'Mailbox connected. The beta sync reads mailbox metadata only.':params.get('email_error')?'Mailbox connection did not complete. Please try again.':'';
 box.innerHTML=`<section class="sum"><div class="eyebrow">Pro · invited beta</div><h1 class="serif">Email briefing preview</h1><p class="tag">Connect a read-only mailbox and test the report schedule. This beta uses fixture summaries only; it does not read email subjects or bodies or send them to an AI service.</p></section><div class="email-beta"><section class="card"><h2 class="serif">Before you connect</h2><p>Google's <code>gmail.metadata</code> permission can access message headers and labels; Microsoft's <code>Mail.ReadBasic</code> permission can access basic fields such as subject and sender. This beta requests only Gmail message IDs and change history, or Outlook message IDs and received times. It does not fetch or store subjects, senders, bodies, or attachments. Google classifies this as a restricted scope and may require verification and a security assessment. Disconnect removes the saved token and sync state.</p><label class="email-consent"><input id="email-consent" type="checkbox"> I understand and consent to read-only mailbox metadata access for this beta.</label><div class="email-actions"><button class="btn" data-email-action="connect" data-provider="gmail">Connect Gmail</button><button class="btn" data-email-action="connect" data-provider="outlook">Connect Outlook</button><button class="btn" data-email-action="preview">Send a synthetic test report</button></div><p id="email-message" class="email-message" aria-live="polite">${esc(notice)}</p></section><section class="card"><h2 class="serif">Your connections</h2><div id="email-connections" class="email-connections">Loading…</div></section><section class="card"><h2 class="serif">Scheduled roll-up</h2><p>Every 100 new messages creates a clearly labeled synthetic batch report. The scheduled report is created near the selected local time.</p><form id="email-settings" class="email-settings"><label>Time zone<input id="email-timezone" required value="${esc(Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Kolkata')}"></label><label>Report time<input id="email-time" type="time" step="900" required value="07:00"></label><button class="btn fill" type="submit">Save schedule</button></form></section><section class="card"><h2 class="serif">Recent reports</h2><div id="email-reports" class="email-reports">Loading…</div></section></div>`;
 const message=$('#email-message');
 const load=async()=>{
  const data=await emailApi('/api/email/settings');
  $('#email-timezone').value=data.settings.timezone;
  $('#email-time').value=data.settings.digest_time;
  $('#email-connections').innerHTML=data.connections.length?data.connections.map(c=>`<div class="email-connection"><div><b>${esc(c.provider)}</b> · ${esc(c.provider_email)}<small>Last sync: ${c.last_sync_at?esc(new Date(c.last_sync_at).toLocaleString()):'pending'}${c.last_error?' · '+esc(c.last_error):''}</small></div><button class="link" data-email-action="disconnect" data-provider="${esc(c.provider)}">Disconnect</button></div>`).join(''):'<p>No mailboxes connected.</p>';
  $('#email-reports').innerHTML=data.reports.length?data.reports.map(r=>`<article class="email-report"><div class="eyebrow">${esc(r.report.label||'SYNTHETIC EXAMPLE')} · ${esc(r.kind)}</div><h3>${esc(r.report.title||'Beta report')}</h3><p>${esc(r.report.summary||'')}</p><small>${r.email_count} new messages detected from metadata · ${esc(new Date(r.created_at).toLocaleString())} · email: ${esc(r.delivery_status)}</small></article>`).join(''):'<p>No reports yet. Use the synthetic test button to preview one.</p>';
 };
 try{await load()}catch(error){message.textContent=error.message}
 box.onclick=async(event)=>{
  const button=event.target.closest('[data-email-action]');if(!button)return;
  const action=button.dataset.emailAction;button.disabled=true;message.textContent='';
  try{
   if(action==='connect'){
    if(!$('#email-consent').checked)throw new Error('Confirm the beta consent before connecting.');
    const result=await emailApi('/api/email/connect','POST',{provider:button.dataset.provider,consent:true});
    location.assign(result.authorize_url);return
   }
   if(action==='disconnect'){
    const result=await emailApi('/api/email/disconnect','POST',{provider:button.dataset.provider});
    message.textContent=result.warning||'Mailbox disconnected.';
   }else if(action==='preview'){
    const result=await emailApi('/api/email/preview','POST',{});
    message.textContent=result.notice
   }
   await load()
  }catch(error){message.textContent=error.message}
  finally{button.disabled=false}
 };
 $('#email-settings').onsubmit=async(event)=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;message.textContent='';
  try{await emailApi('/api/email/settings','POST',{timezone:$('#email-timezone').value,digest_time:$('#email-time').value});message.textContent='Schedule saved.'}
  catch(error){message.textContent=error.message}
  finally{button.disabled=false}
 }
}
// after feedback, re-rank only what the reader has not seen yet
function reTail(){if(TAB!=='read')return;const keep=READ.slice(0,SHOWN),ids=new Set(keep.map(c=>c.i.id)),cl=new Set(keep.map(c=>c.i.c));
 READ=keep.concat(rank(POOL.items.filter(i=>!ids.has(i.id)&&!cl.has(i.c)),(BS.readCap||200)-keep.length,false))}
function like(i){const x=PR.lk.indexOf(i.id);if(x>=0){PR.lk.splice(x,1);persist();return false}PR.lk.push(i.id);ACT.add(i.id);learn(i,{c:1,l:1},1.2);reTail();return true}
function save(i){const x=PR.sv.indexOf(i.id);if(x>=0){PR.sv.splice(x,1);persist();return false}PR.sv.push(i.id);ACT.add(i.id);learn(i,{c:1,s:1},1.5);reTail();return true}
function hide(i){PR.hid.push(i.id);ACT.add(i.id);learn(i,{k:1},-1.5);reTail()}
function play(i){
 ACT.add(i.id);let dur=0,st=-1,watched=0,got=false;const t0=Date.now(),
 m=modal(`<div class="pw"><iframe id="yt" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(i.vid)}?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}" title="${esc(i.t)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><h3 class="serif" style="margin:14px 0 4px">${esc(i.t)}</h3><small>${esc(i.s)} · <a href="https://www.youtube.com/watch?v=${encodeURIComponent(i.vid)}" target="_blank" rel="noopener noreferrer">Open on YouTube</a></small><div class="acts"><span></span><span><button data-a="like">♥ Like</button><button data-a="hide">✕ Not for me</button></span></div>`,'vid'),
 f=$('#yt');f.onload=()=>f.contentWindow.postMessage(JSON.stringify({event:'listening',id:1,channel:'widget'}),'*');
 const on=e=>{try{if(!/(^|\.)youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname))return;const d=typeof e.data==='string'?JSON.parse(e.data):e.data;if(d.event==='infoDelivery'&&d.info){got=true;if(d.info.duration)dur=d.info.duration;if(d.info.playerState!=null)st=d.info.playerState}}catch{}},
 tick=setInterval(()=>{if(st===1)watched++},1000);addEventListener('message',on);
 m.onclick=e=>{const a=e.target.dataset?.a;if(a==='like'){e.target.classList.toggle('on',like(i))}else if(a==='hide'){hide(i);closeModal()}};
 onClose=()=>{clearInterval(tick);removeEventListener('message',on);const w=got?watched:(Date.now()-t0)/1000*.6,r=dur?cl(w/dur,0,1):cl(w/120,0,1);learn(i,{c:1,l:r>.6?1:0,k:w<4?1:0},w<4?-.6:2*r-.5);if(TAB==='watch'&&$('#am'))renderWatch()}}
$('#app').addEventListener('click',e=>{const b=e.target.closest('[data-a]');if(!b)return;const a=b.dataset.a,card=b.closest('[data-id]'),i=ITEM[card?.dataset.id];
 if(a==='so')return out();if(a==='ep'){location.hash='#/';setTimeout(()=>$('#tune')?.scrollIntoView({behavior:'smooth'}),80);return}
 if(a==='pf'){PF=b.dataset.k;return renderRead()}if(!i)return;
 if(a==='open'){ACT.add(i.id);learn(i,{c:1},.5)}
 else if(a==='like')b.classList.toggle('on',like(i));else if(a==='save')b.classList.toggle('on',save(i));
 else if(a==='hide'){hide(i);card.remove()}else if(a==='vp')play(i)});
$('#app').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.dataset?.a==='vp'){e.preventDefault();e.target.click()}});

/* ---------- routing ---------- */
export async function route(){
 const rid=++RID;obs?.disconnect();sobs?.disconnect();VIS.clear();
 const r=fromHash();
 if(/^#\/(pricing|paused|account)(\/|$)/.test(location.hash))return;
 if(r==='ok'){await loadUser().catch(()=>{});await pull();location.hash='#/me/read';return}
 if(r)openAuth('Sign-in did not complete: '+r,'in');
 if(/^#\/email(?:\?|$)/.test(location.hash)){const home=$('#home'),app=$('#app');if(!S){home.hidden=false;app.hidden=true;openAuth('Sign in to use the invited email beta.','in');return}
  home.hidden=true;app.hidden=false;shell('email');$('#am').innerHTML='<div class="end">Loading email beta…</div>';await renderEmailBeta();scrollTo(0,0);return}
 const m=location.hash.match(/^#\/me(?:\/(read|watch))?/),home=$('#home'),app=$('#app');
 if(!m){home.hidden=false;app.hidden=true;return}
 if(!S){home.hidden=false;app.hidden=true;history.replaceState(null,'',location.pathname);openAuth('Sign in to open your personal briefing.','in');return}
 home.hidden=true;app.hidden=false;TAB=m[1]||'read';shell(TAB);$('#am').innerHTML='<div class="end">Building your feed…</div>';
 await loadPool();if(rid!==RID||!location.hash.startsWith('#/me'))return;
 await window.BSAccess?.ready;if(rid!==RID||!location.hash.startsWith('#/me'))return;
 TAB==='read'?renderRead():renderWatch();scrollTo(0,0)}
window.BSAuth={token:()=>token(),user:()=>S?.u||null,has:()=>!!S};
paintHs();paintFooter();addEventListener('hashchange',route);
(async()=>{if(S&&!S.u)await loadUser().catch(()=>{});await route();if(S)pull().then(c=>{if(c){document.dispatchEvent(new Event('bs:prefs'));if(!$('#app').hidden)route()}})})();
