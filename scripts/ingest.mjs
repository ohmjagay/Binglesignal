// BingleSignal ingest engine v5. Public story data is written to Supabase; only a teaser remains public.
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CATS,CC,EUROPE,cname} from '../public/taxonomy.js';
import {summarizeStory} from './story-summary.mjs';
const [G,I,U,E]=['GL','IN','US','EU'],UA='Mozilla/5.0 (compatible; BingleSignalBot/5.0; +https://binglesignal.com)',HL={n:14,r:20,h:16,b:48,y:96};
// Publisher feeds: ['feed url','Source',region,'default topics',trust 0-1]. Add or remove lines freely.
const FEEDS=[
['https://techcrunch.com/feed/','TechCrunch',G,'tech startups',.8],
['https://techcrunch.com/category/artificial-intelligence/feed/','TechCrunch AI',G,'ai tech',.8],
['https://techcrunch.com/category/fintech/feed/','TechCrunch Fintech',G,'fintech startups',.8],
['https://www.theverge.com/rss/index.xml','The Verge',G,'tech',.75],
['https://feeds.arstechnica.com/arstechnica/index','Ars Technica',G,'tech science',.8],
['https://www.technologyreview.com/feed/','MIT Technology Review',G,'ai tech science',.85],
['https://venturebeat.com/category/ai/feed/','VentureBeat',G,'ai tech',.7],
['https://yourstory.com/feed','YourStory',I,'startups',.7],
['https://inc42.com/feed/','Inc42',I,'startups',.75],
['https://www.livemint.com/rss/companies','Mint',I,'business',.85],
['https://www.livemint.com/rss/markets','Mint Markets',I,'markets business',.85],
['https://economictimes.indiatimes.com/small-biz/rssfeeds/11993034.cms','ET SmallBiz',I,'msme business',.8],
['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms','Economic Times',I,'markets business',.85],
['https://auto.economictimes.indiatimes.com/rss/topstories','ET Auto',I,'auto business',.8],
['https://www.thehindu.com/news/national/feeder/default.rss','The Hindu',I,'policy',.85],
['https://www.thehindu.com/business/feeder/default.rss','The Hindu Business',I,'business',.85],
['https://indianexpress.com/section/india/feed/','Indian Express',I,'policy',.8],
['https://feeds.feedburner.com/ndtvnews-top-stories','NDTV',I,'',.75],
['https://timesofindia.indiatimes.com/rssfeedstopstories.cms','Times of India',I,'',.7],
['https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml','Hindustan Times',I,'',.75],
['https://feeds.npr.org/1001/rss.xml','NPR',U,'policy',.85],
['https://www.cnbc.com/id/10001147/device/rss/rss.html','CNBC',U,'business markets',.8],
['https://rss.nytimes.com/services/xml/rss/nyt/Business.xml','New York Times',U,'business',.9],
['https://feeds.bbci.co.uk/news/world/rss.xml','BBC News',G,'world',.9],
['https://feeds.bbci.co.uk/news/business/rss.xml','BBC Business',G,'business',.9],
['https://www.aljazeera.com/xml/rss/all.xml','Al Jazeera',G,'world',.8],
['https://www.theguardian.com/world/rss','The Guardian',G,'world',.85],
['https://rss.dw.com/rdf/rss-en-all','DW',E,'world business',.85],
['https://www.theguardian.com/world/europe-news/rss','The Guardian Europe',E,'world policy',.85],
['https://www.carscoops.com/feed/','Carscoops',G,'auto',.7],
['https://www.motor1.com/rss/articles/all/','Motor1',G,'auto',.75],
['https://electrek.co/feed/','Electrek',G,'auto climate',.7],
['https://www.sciencedaily.com/rss/top.xml','ScienceDaily',G,'science',.75],
['https://www.nature.com/nature.rss','Nature',G,'science',.9],
['https://feeds.bbci.co.uk/news/health/rss.xml','BBC Health',G,'health',.85],
['https://www.theguardian.com/environment/climate-crisis/rss','The Guardian Climate',G,'climate',.85],
['https://feeds.bbci.co.uk/sport/rss.xml','BBC Sport',G,'sports',.85],
['https://www.espncricinfo.com/rss/content/story/feeds/0.xml','ESPNcricinfo',G,'sports',.8],
['https://variety.com/feed/','Variety',G,'media',.75],
['https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml','BBC Culture',G,'media',.8],
['https://www.sec.gov/news/pressreleases.rss','U.S. SEC',U,'markets policy',1],
['https://www.sebi.gov.in/sebirss.xml','SEBI',I,'markets policy',1],
['https://ec.europa.eu/commission/presscorner/api/rss?language=en','European Commission',E,'policy world',1],
['https://www.federalregister.gov/documents/search.atom?conditions%5Btype%5D%5B%5D=RULE','Federal Register',U,'policy',1]];
const MAP={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
const ent=(m,e)=>{e=e.toLowerCase();try{return e[0]==='#'?String.fromCodePoint(e[1]==='x'?parseInt(e.slice(2),16):+e.slice(1)):MAP[e]??m}catch{return m}};
const txt=s=>{s=(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&(#x?[\da-f]+|\w+);/gi,ent).replace(/<[^>]+>/g,' ');return s.replace(/&(#x?[\da-f]+|\w+);/gi,ent).replace(/\s+/g,' ').trim()};
const tag=(b,n)=>(b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`,'i'))||[])[1]||'';
const link=b=>txt(tag(b,'link'))||(b.match(/<link[^>]+href=["']([^"']+)["']/i)||[])[1]||txt(tag(b,'guid'));
const img=b=>{b=b.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');const m=b.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i)||b.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i)||b.match(/<img[^>]+src=["']([^"']+)["']/i);const u=m?m[1].replace(/&amp;/g,'&'):'';return /^https:\/\//.test(u)?u:''};
const uid=u=>sha(canonicalUrl(u)).slice(0,24);
const rxEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// ---- more sources, generated from the taxonomy: Google News per interest and country edition, Reddit per interest, Medium tags, YouTube channels
const GEOS=['US','IN','GB','DE'];   // Google News editions to pull. Add a country code (for example 'AU') to serve that country better.
const gq=c=>[c[1].replace(/&/g,' '),...c[3].split('|').filter(w=>/^[a-z][a-z ]{2,}$/i.test(w)).slice(0,3)].map(w=>`"${w.trim()}"`).join(' OR ');
const gn=(q,g)=>`https://news.google.com/rss/search?q=${encodeURIComponent(q+' when:2d')}&hl=en-${g}&gl=${g}&ceid=${g}:en`;
const have=new Map(FEEDS.map(r=>[r[0],r]));
const add=r=>{const o=have.get(r[0]);if(o)o[3]+=' '+r[3];else{have.set(r[0],r);FEEDS.push(r)}};
for(const c of CATS){
 if(c[0]==='trending')continue;
 if(c[0]==='local'){for(const g of GEOS)add([`https://news.google.com/rss?hl=en-${g}&gl=${g}&ceid=${g}:en`,'Google News',g,'local',.7,'n',1.2]);continue}
 for(const g of c[4]?GEOS:['US'])add([gn(gq(c),g),'Google News',c[4]?g:G,c[0],.65,'n',1.2]);
 // Reddit removed: its terms require a commercial agreement (see docs/LAUNCH_BREAKDOWN.md)
}
const MED={startups:'startup',ai:'artificial-intelligence',tech:'technology',business:'business',jobs:'careers',crypto:'cryptocurrency',science:'science',health:'health',fitness:'fitness',climate:'climate-change',edu:'education',travel:'travel',food:'food',fashion:'fashion',beauty:'beauty',parenting:'parenting',books:'books',gaming:'gaming',music:'music'};
for(const [c,t] of Object.entries(MED))add([`https://medium.com/feed/tag/${t}`,'Medium',G,c,.55,'b',1]);
// YouTube channels (free RSS, no key): channel id | name | interests | region | trust. If the log shows "skip" for one, its id is wrong - delete the line.
const YT=`UCUMZ7gohGI9HcU9VNsr2FJQ|Bloomberg Originals|business markets startups||.9
UCrM7B7SL_g1edFOnmj-SDKg|Bloomberg Television|markets business||.9
UCvJJ_dzjViJCoLf5uKUTwoA|CNBC|business markets|US|.85
UCK7tptUDHh-RYDsdxO1-5QQ|The Wall Street Journal|business markets|US|.85
UCoUxsWakJucWg46KW5RsvPw|Financial Times|business markets world||.85
UCcefcZRL2oaA_uBNeo5UOWg|Y Combinator|startups funding||.85
UCyaN6mg5u8Cjy2ZI4ikWaug|My First Million|startups business||.75
UCV6KDgJskWaEckne5aPA0aQ|Graham Stephan|markets realestate|US|.65
UCBJycsmduvYEL83R_U4JriQ|MKBHD|tech||.85
UCsBjURrPoezykLs9EqgamOA|Fireship|tech ai||.8
UCSHZKyawb77ixDdsGog4iWA|Lex Fridman|ai science||.8
UCNJ1Ymd5yFuUPtn21xtRbbw|AI Explained|ai||.8
UCbfYPyITQ-7l4upoX8nvctg|Two Minute Papers|ai science||.8
UCP7jMXSY2xbc3KCAE0MHQ-A|Google DeepMind|ai||.85
UCXZCJLdBC09xxGZ6gcdrc6A|OpenAI|ai||.85
UCHuiy8bXnmK5nisYHUd1J5g|NVIDIA|ai tech||.8
UCXUPKJO5MZQN11PqgIvyuvQ|Andrej Karpathy|ai||.8
UCHnyfMqiRRG1u-2MsSQLbXA|Veritasium|science||.8
UCsXVk37bltHxD1rDPwtNM8Q|Kurzgesagt|science space||.8
UCYO_jab_esuFRV4b17AJtAw|3Blue1Brown|science||.75
UCAuUUnT6oDeKwE6v1NGQxug|TED|science books||.8
UCuCkxoKLYO_EQ2GeFtbM_bw|Climate Town|climate energy||.75
UCpVm7bg6pXKo1Pr6k5kxG9A|National Geographic|travel science pets||.8
UCwmZiChSryoWQCZMIQezgTg|BBC Earth|pets travel science||.8
UC16niRr50-MSBwiO3YDb3RA|BBC News|world||.9
UCNye-wNBqNL5ZzHSJj3l8Bg|Al Jazeera English|world||.85
UCknLrEdhRCp1aegoMqRaCZg|DW News|world|EU|.85
UCupvZG-5ko_eiXAupbDfxWw|CNN|world policy|US|.8
UCLXo7UDZvByw2ixzpQCufnA|Vox|policy world|US|.8
UCmGSJVG3mCRXVOP4yZrU1Dw|Johnny Harris|world||.75
UC9RM-iSvTu1uPJb8X5yp3EQ|Wendover Productions|mfg aviation world||.75
UC_gUM8rL-Lrg6O3adPW9K1g|WION|world india|IN|.8
UCZFMm1mMw0F81Z37aaEzTUA|NDTV|india local|IN|.8
UCYPvAwZP8pZhSMW8qs7cVCw|India Today|india local|IN|.75
UC-CSyyi47VX1lD9zyeABW3w|Dhruv Rathee|india policy|IN|.7
UCoMdktPbSTixAyNGwb-UYkQ|Sky News|world local|GB|.8
UCsqjHFMB_JYTaEnf_vmTNqg|Doug DeMuro|auto||.75
UCjOl2AUblVmg2rA_cRgZkFg|Top Gear|auto|GB|.75
UCJ24N4O0bP7LGLBDvye7oCA|Nas Daily|travel vlog||.65
UCbpMy0Fg74eXXkvxJrtEn3w|Bon Appetit|food||.75
UCRXiA3h1no_PFkb1JCP0yMA|Vogue|fashion beauty||.8
UCWOA1ZGywLbqmigxE4Qlvuw|Netflix|hollywood ott media||.8
UCvC4D8onUfXzvjTOM-dBfEA|Marvel Entertainment|hollywood media||.8
UCjmJDM5pRKbUlVIzDYYWb6g|Warner Bros. Pictures|hollywood||.75
UCq-Fj5jknLsUf-MWSy4_brA|T-Series|bollywood music|IN|.75
UCFFbwnve3yF62-tVXkTyHqg|Zee Music Company|bollywood music|IN|.7
UC3IZKseVpdzPSBaWxBxundA|HYBE LABELS|korean music||.8
UCOmHUn--16B90oW2L6FRR3A|BLACKPINK|korean music||.8
UCLkAepWjdylmXSltofFvsYQ|BANGTANTV|korean music||.8
UCX6OQ3DkcsbYNE6H8uQQuVA|MrBeast|vlog media||.75
UCqFzWxSCi39LnW1JKFR3efg|Saturday Night Live|memes media|US|.65
UCKy1dAqELo0zrOtPkf0eTMw|IGN|gaming||.75
UCiWLfSweyRNmLpgEHekhoAg|ESPN|sports|US|.75
UCNAf1k0yIjyGu3k9BwAg3lg|Sky Sports Football|football|GB|.75
UCt2JXOLNxqry7B_4rRZME3Q|ICC|cricket||.8
UCB_qr75-ydFVKSF9Dmo6izg|Formula 1|f1||.8
UCWJ2lWNubArHWmf3FIHbfcQ|NBA|basket|US|.75`.trim().split('\n').map(l=>l.split('|'));
for(const [id,n,top,r,tr] of YT)add([`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,n,r||G,top,+tr,'y',.9]);

const sourceTier=source=>{
 const name=String(source||'').toLowerCase();
 if(/sec|sebi|federal register|european commission|rbi|pib|mca|cbic|dgft|trai|cci|irdai|fssai|nse|bse/.test(name))return 1;
 if(/bbc|new york times|financial times|mint|economic times|business standard|the hindu|reuters|cnbc|npr/.test(name))return 2;
 if(/techcrunch|inc42|entrackr|yourstory|venturebeat|technology review|ars technica|the verge|variety/.test(name))return 3;
 return 4;
};
const canonicalUrl=value=>{
 const url=new URL(value);url.hash='';
 for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid|mc_cid|mc_eid|ref|source)$/i.test(key))url.searchParams.delete(key);
 url.hostname=url.hostname.toLowerCase().replace(/^www\./,'');
 if(url.pathname.length>1)url.pathname=url.pathname.replace(/\/+$/,'');
 url.searchParams.sort();return url.toString();
};
const sha=value=>createHash('sha256').update(value).digest('hex');
const cleanText=value=>String(value||'').replace(/https?:\/\/\S+/gi,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const apiRequest=async(path,init={})=>{
 const response=await fetch(`${process.env.SUPABASE_URL}${path}`,{...init,headers:{
  apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'content-type':'application/json',...init.headers
 }});
 if(!response.ok)throw new Error(`Supabase ingest request failed (${response.status})`);
 const text=await response.text();return text?JSON.parse(text):[];
};
const cloudflareEmbedding=async texts=>{
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
 if(!account||!token)throw new Error('Cloudflare AI account settings are required for story embeddings');
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/@cf/baai/bge-small-en-v1.5`,{
  method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({text:texts})
 });
 if(!response.ok)throw new Error(`Story embedding request failed (${response.status})`);
 const result=await response.json();if(!result.success||!Array.isArray(result.result?.data))throw new Error('Story embedding response was invalid');
 return result.result.data;
};
async function pull([url,s,r,top,tr=.75,p='n',pw=.85]){
 try{
  const res=await fetch(url,{headers:{'user-agent':UA,accept:'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*'},signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const xml=await res.text(),out=[];let idx=0;
  for(const b of (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)||[]).slice(0,p==='y'?15:p==='r'?25:16)){
   let t=txt(tag(b,'title')),u=link(b);const d=new Date(txt(tag(b,'pubDate')||tag(b,'published')||tag(b,'updated')||tag(b,'dc:date')));
   if(!t||!/^https?:\/\//.test(u)||isNaN(d)||Date.now()-d>(p==='y'?14*864e5:96*36e5))continue;
   let src=s;const so=b.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
   if(so){src=txt(so[1])||s;t=t.replace(new RegExp('\\s+-\\s+'+rxEsc(src)+'$'),'')}
   let x=txt(tag(b,'description')||tag(b,'summary')||tag(b,'content:encoded')||tag(b,'media:description')||tag(b,'content')).replace(/\s*The post .{0,200}appeared first on .*$/i,'').replace(/submitted by.*$/i,'');
   x=x.length<40||x.startsWith(t)?'':x.length>240?x.slice(0,239).replace(/\s+\S*$/,'')+'…':x;
   const it={id:uid(u),t,u,s:src,d:new Date(Math.min(d,Date.now())).toISOString(),r,top,x,i:img(b),p,pw,tr};
   if(p==='y'){it.v=1;it.vid=txt(tag(b,'yt:videoId'));it.e=+((b.match(/<media:statistics views="(\d+)"/)||[])[1]||0);if(!it.vid)continue}
   if(p==='r')it.e=Math.max(10,(26-idx)*12);
   idx++;out.push(it)}
  console.log('ok  ',s,out.length);return out
 }catch(e){console.log('skip',s,e.message);return[]}
}
async function pullHN(){
 try{const j=await(await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60',{signal:AbortSignal.timeout(15000)})).json();
  const o=j.hits.filter(h=>h.title).map(h=>{const u=h.url||'https://news.ycombinator.com/item?id='+h.objectID;return{id:uid(u),t:h.title,u,s:'Hacker News',d:new Date(h.created_at_i*1000).toISOString(),r:G,top:'tech startups',x:'',i:'',p:'h',pw:.85,tr:.7,e:(h.points||0)+2*(h.num_comments||0)}});
  console.log('ok   Hacker News',o.length);return o}catch(e){console.log('skip Hacker News',e.message);return[]}}
// Optional keyword video search (needs the free YOUTUBE_API_KEY secret). Each run searches a quarter of the interests, so the daily quota is never exceeded.
async function pullYT(){
 const key=process.env.YOUTUBE_API_KEY;if(!key){console.log('skip YouTube keyword search (no YOUTUBE_API_KEY secret)');return[]}
 try{
  const run=Math.floor(new Date().getUTCHours()/6),cs=CATS.filter(c=>!['trending','local'].includes(c[0])).filter((_,j)=>j%4===run),after=new Date(Date.now()-14*864e5).toISOString();
  const rs=(await Promise.all(cs.map(async c=>{try{const j=await(await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&order=relevance&relevanceLanguage=en&publishedAfter=${after}&q=${encodeURIComponent(gq(c).replace(/"/g,''))}&key=${key}`)).json();if(j.error)throw new Error(j.error.message);return(j.items||[]).map(v=>({c:c[0],v}))}catch(e){console.log('skip YouTube search',c[0],e.message);return[]}}))).flat();
  const st={},ids=[...new Set(rs.map(x=>x.v.id.videoId))];
  for(let k=0;k<ids.length;k+=50){try{const j=await(await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.slice(k,k+50).join(',')}&key=${key}`)).json();for(const v of j.items||[])st[v.id]=+v.statistics.viewCount||0}catch{}}
  console.log('ok   YouTube keyword search',rs.length);
  return rs.map(({c,v})=>{const u='https://www.youtube.com/watch?v='+v.id.videoId;return{id:uid(u),t:txt(v.snippet.title),u,s:txt(v.snippet.channelTitle),d:v.snippet.publishedAt,r:G,top:c,x:txt(v.snippet.description).slice(0,200),i:'',p:'y',pw:1.1,tr:.6,v:1,vid:v.id.videoId,e:st[v.id.videoId]||0}})
 }catch(e){console.log('skip YouTube search',e.message);return[]}}
async function pmap(rows,fn,n=12){const out=[];let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<rows.length){const j=i++;out[j]=await fn(rows[j])}}));return out}
if(process.argv.includes('--check-feeds')){
 const checks=await pmap(FEEDS,async([url,name])=>{
  try{const response=await fetch(url,{headers:{'user-agent':UA},signal:AbortSignal.timeout(8000)});
   const state=response.ok?'OK':[419,429].includes(response.status)||response.status>=500?'RETRY':'DROP';
   return{name,url,status:response.status,state,ok:response.ok}}
  catch(error){return{name,url,status:error.name==='TimeoutError'?'timeout':'network-error',state:'RETRY',ok:false}}
 },20);
 for(const result of checks)console.log(`${result.state} ${result.status} ${result.name} ${result.url}`);
 console.log(`Feed check complete: ${checks.filter(result=>result.state==='OK').length} OK, ${checks.filter(result=>result.state==='RETRY').length} transient, ${checks.filter(result=>result.state==='DROP').length} dead out of ${checks.length}.`);
 process.exit(0);
}

// ---- classification: interest tags (feed provenance + keyword match) and geography (source country = strict, mentioned countries = soft)
const RX=CATS.filter(c=>c[3]).map(c=>[c[0],new RegExp(c[3],'i')]);
const NAMES=CC.split(' ').map(c=>[c,cname(c)]),N2C=Object.fromEntries(NAMES.map(([c,n])=>[n,c])),
 GRX=new RegExp('\\b('+NAMES.map(([,n])=>rxEsc(n)).join('|')+')\\b','g'),
 ALIAS=[['US',/\bU\.S\.|\bAmerica\b/],['GB',/\bBritain\b|\bUK\b|\bU\.K\.|\bEngland\b/],['AE',/\bUAE\b|\bDubai\b/],['IN',/\bIndian\b|\bMumbai\b|\bDelhi\b|\bBengaluru\b/]];
const mentions=(text,skip)=>{const s=new Set();for(const m of text.matchAll(GRX))s.add(N2C[m[1]]);for(const [c,r] of ALIAS)if(r.test(text))s.add(c);s.delete(skip);return[...s].slice(0,3)};
const classify=(t,x,top,pw)=>{const sc=new Map();for(const id of top.split(' ').filter(Boolean))sc.set(id,pw);for(const [id,rx] of RX){if(rx.test(t))sc.set(id,Math.max(sc.get(id)||0,.8));else if(x&&rx.test(x))sc.set(id,Math.max(sc.get(id)||0,.5))}return[...sc].sort((a,b)=>b[1]-a[1]).slice(0,5).map(a=>a[0])};
// ---- clustering: headlines about the same event are grouped by word overlap (Jaccard), so one event = one story
const STOP=new Set('the and for with from that this these those after over into about how why what when who will new says said more than not but has have had you your our their his her she they can could may might out off amid via per are was were been its'.split(' '));
const toks=t=>new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>2&&!STOP.has(w)));
const same=(a,b)=>{let i=0;for(const w of a)if(b.has(w))i++;const j=i/(a.size+b.size-i||1);return j>=.4||(i>=3&&j>=.27)};

const now=Date.now(),hreg=g=>g==='IN'?'IN':g==='US'?'US':(g==='EU'||EUROPE.has(g))?'EU':'GL';
const cosine=(a,b)=>{if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return 0;let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i]}return d/Math.sqrt(x*y||1)};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
console.log('sources to fetch:',FEEDS.length);
const all=(await pmap(FEEDS,pull)).flat().concat(await pullHN(),await pullYT());
const byUrl=new Map();for(const a of all){a.u=canonicalUrl(a.u);const prior=byUrl.get(a.u);if(prior)prior.top+=' '+a.top;else byUrl.set(a.u,a)}
const items=[...byUrl.values()];
for(const a of items){a.k=classify(a.t,a.x,a.top,a.pw);a.g=a.r&&a.r!==G?[a.r]:[];a.m=mentions(a.t+' '+a.x,a.g[0]);a.tier=sourceTier(a.s);if(a.r===I&&!a.k.includes('india')&&a.k.length<5)a.k.push('india')}
const reads=items.filter(a=>!a.v),vids=items.filter(a=>a.v);
for(const a of reads){a.T=toks(a.t);a.q0=a.tr*.5**((now-new Date(a.d))/36e5/HL[a.p])}
reads.sort((a,b)=>b.q0-a.q0);
const cl=[];for(const a of reads){const c=cl.find(c=>same(a.T,c.rep.T));c?c.m.push(a):cl.push({rep:a,m:[a]})}
for(const c of cl){const n=new Set(c.m.map(x=>x.s)).size;for(const x of c.m){x.c=c.rep.id;x.n=n}}
for(const a of vids){a.c=a.id;a.n=1}
for(const p of ['r','h','y']){const group=items.filter(a=>a.p===p&&a.e!=null);group.forEach(a=>a.vel=a.e/((now-new Date(a.d))/36e5+2)**1.3);group.sort((a,b)=>a.vel-b.vel);group.forEach((a,i)=>a.ep=Math.round(100*i/Math.max(1,group.length-1)))}
for(const a of items){if(a.ep==null)a.ep=Math.min(95,Math.round(30+20*Math.log2(a.n)));a.q=+(a.tr*.5**((now-new Date(a.d))/36e5/HL[a.p])*(1+.55*Math.log2(a.n))*(.7+.6*a.ep/100)).toFixed(4);if((a.n>=3||a.ep>=92)&&!a.k.includes('trending')&&a.k.length<5)a.k.push('trending')}
const keep=(arr,per,cap)=>{const map=new Map();for(const category of CATS)arr.filter(a=>a.k.includes(category[0])).sort((a,b)=>b.q-a.q).slice(0,per).forEach(a=>map.set(a.id,a));[...arr].sort((a,b)=>b.q-a.q).slice(0,cap>>2).forEach(a=>map.set(a.id,a));return[...map.values()].sort((a,b)=>b.q-a.q).slice(0,cap)};
if(!reads.length){console.error('No stories fetched');process.exit(1)}
const selected=keep(reads,70,2600),selectedVideos=keep(vids,30,600);
const embeddingBatches=[];for(let i=0;i<cl.length;i+=100)embeddingBatches.push(cl.slice(i,i+100));
for(const batch of embeddingBatches){
 const vectors=await cloudflareEmbedding(batch.map(group=>`${group.rep.t}. ${cleanText(group.rep.x).slice(0,400)}`));
 if(vectors.length!==batch.length)throw new Error('Story embedding count did not match the request');
 batch.forEach((group,index)=>{group.embedding=vectors[index];for(const item of group.m)item.embedding=vectors[index]});
}
const oldClusters=await apiRequest(`/rest/v1/story_clusters?select=story_id,stories,embedding,source_tier,source_count,published_at,expires_at&published_at=gte.${encodeURIComponent(new Date(now-72*36e5).toISOString())}&order=published_at.desc&limit=2000`);
for(const group of cl){
 let best=null,similarity=.78;
 for(const old of oldClusters){const score=cosine(group.embedding,old.embedding);if(score>=similarity){best=old;similarity=score}}
 if(best)for(const item of group.m)item.c=best.story_id;
}
const rowsById=new Map();
const serializeStory=item=>({id:item.id,t:item.t,u:item.u,s:item.s,d:Math.floor(+new Date(item.d)/1000),p:item.p,
 ...(item.v?{v:1,vid:item.vid}:{}),k:item.k,...(item.g.length?{g:item.g}:{}),...(item.m.length?{m:item.m}:{}),
 ...(item.x?{x:item.x}:{}),c:item.c,n:item.n,q:item.q,ep:item.ep,...(item.e!=null?{e:Math.round(item.e)}:{}),
 tr:item.tr,source_tier:item.tier,...(item.embedding?{embedding:item.embedding}:{})});
for(const item of [...selected,...selectedVideos]){
 const storyId=item.c,group=rowsById.get(storyId)||{story_id:storyId,items:[],embedding:item.embedding||null,source_tier:item.tier,source_count:0,published_at:item.d};
 group.items.push(serializeStory(item));group.source_tier=Math.min(group.source_tier,item.tier);if(new Date(item.d)>new Date(group.published_at))group.published_at=item.d;rowsById.set(storyId,group);
}
const clusterRows=[...rowsById.values()].map(group=>{
 const existing=oldClusters.find(row=>row.story_id===group.story_id),merged=new Map();
 for(const item of [...(existing?.stories||[]),...group.items])merged.set(item.u,item);
 const stories=[...merged.values()].sort((a,b)=>new Date(b.d)-new Date(a.d)).slice(0,12);
 return{story_id:group.story_id,stories,embedding:group.embedding,source_tier:group.source_tier,
  source_count:new Set(stories.map(item=>item.s)).size,published_at:new Date(group.published_at).toISOString(),
  expires_at:new Date(Math.max(now,Date.parse(group.published_at))+7*864e5).toISOString(),updated_at:new Date().toISOString()};
});
const noteLookups=[];for(let i=0;i<clusterRows.length;i+=200)noteLookups.push(clusterRows.slice(i,i+200));
const oldNotes=(await Promise.all(noteLookups.map(group=>apiRequest(
 `/rest/v1/story_notes?select=story_id,headline,summary,why_it_matters,do_next,category,entities,confidence,source_ids&story_id=in.(${group.map(row=>encodeURIComponent(row.story_id)).join(',')})`
)))).flat();
const notesById=new Map(oldNotes.map(note=>[note.story_id,note]));
const notesToWrite=[];
for(let offset=0;offset<clusterRows.length;offset+=8){
 const batch=clusterRows.slice(offset,offset+8);
 const generated=await pmap(batch,async cluster=>{
  if(notesById.has(cluster.story_id))return null;
  if(cluster.stories[0]?.v)return null;
  const summary=await summarizeStory(cluster.stories);
  if(!summary)throw new Error('Configure EMAIL_AI_API_KEY and the story summary provider before publishing');
  return{story_id:cluster.story_id,headline:summary.headline,summary:summary.summary,why_it_matters:summary.why_it_matters,
   do_next:null,category:summary.category.slice(0,40),entities:summary.entities.slice(0,12).map(value=>cleanText(value).slice(0,80)),
   confidence:summary.confidence,source_ids:summary.source_ids,source_count:cluster.source_count,
   sources:cluster.stories.map(item=>({name:item.s,url:item.u})),edition_at:new Date().toISOString()};
 });
 notesToWrite.push(...generated.filter(Boolean));
 if(offset+8<clusterRows.length)await wait(250);
}
for(let offset=0;offset<clusterRows.length;offset+=100){
 await apiRequest('/rest/v1/story_clusters?on_conflict=story_id',{method:'POST',headers:{prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(clusterRows.slice(offset,offset+100))});
}
for(let offset=0;offset<notesToWrite.length;offset+=100){
 await apiRequest('/rest/v1/story_notes?on_conflict=story_id',{method:'POST',headers:{prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(notesToWrite.slice(offset,offset+100))});
}
await apiRequest(`/rest/v1/story_clusters?expires_at=lt.${encodeURIComponent(new Date(now).toISOString())}`,{method:'DELETE',headers:{prefer:'return=minimal'}});
const feed=keep(reads.filter(a=>a.p!=='r'),4,30).map(a=>({id:a.id,t:a.t,u:a.u,s:a.s,d:new Date(a.d).toISOString(),r:hreg(a.r),k:a.k,c:a.c,n:a.n,q:a.q}));
await writeFile('public/feed.json',JSON.stringify({v:5,gen:new Date(now).toISOString(),n:feed.length,items:feed}));
console.log(`Supabase story clusters updated: ${clusterRows.length}; new notes: ${notesToWrite.length}; public teaser: ${feed.length}`);
