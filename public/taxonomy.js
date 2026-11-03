// BingleSignal taxonomy. Shared by the website (app.js, index.html) and the feed-builder robot (scripts/ingest.mjs).
// To add an interest: add one line to CATS. Nothing else needs to change.
export const GROUPS={biz:'Business & Tech',pol:'World & Policy',sci:'Science & Health',ind:'Industries',life:'Lifestyle',ent:'Entertainment',spt:'Sports'};
// [id, label, group, keywords (regex), geography-strict (1 = only show stories from the reader's countries), subreddits]
export const CATS=[
['startups','Founder & Startups','biz','startups?|founders?|unicorn|seed round|bootstrapp|y combinator|accelerator',1,'startups,Entrepreneur'],
['funding','Funding & VC','biz','funding round|series [a-d]\\b|venture capital|valuation|vc firm|raises? funding|fundrais',1,'venturecapital'],
['ai','AI','biz','\\bai\\b|artificial intelligence|llms?\\b|openai|anthropic|gemini|chatgpt|machine learning|generative|nvidia',0,'artificial,MachineLearning'],
['tech','Technology','biz','software|semiconductor|chipmaker|smartphones?|iphone|android|gadgets?|cloud computing|data cent|robot|quantum',0,'technology,gadgets'],
['business','Business','biz','business|compan(?:y|ies)|\\bceo\\b|merger|acquisition|acquires|revenue|profit|earnings',1,'business'],
['markets','Markets','biz','stocks?\\b|sensex|nifty|nasdaq|wall street|shares\\b|bond yield|rupee|inflation|interest rate|\\bipo\\b|commodit',1,'stocks,investing'],
['fintech','Fintech','biz','fintech|\\bupi\\b|payments?\\b|neobank|nbfc|lending|paytm|phonepe|razorpay|stripe|digital bank',1,'fintech'],
['crypto','Crypto & Web3','biz','crypto|bitcoin|ethereum|blockchain|web3|stablecoin|\\bdefi\\b',0,'CryptoCurrency,Bitcoin'],
['msme','MSME & Small Business','biz','msmes?\\b|\\bsmes?\\b|small business|small-scale|artisans?|\\bgst\\b|cottage industr',1,'smallbusiness'],
['b2bc','B2B & B2C Commerce','biz','b2b|b2c|\\bsaas\\b|enterprise software|\\bd2c\\b|direct-to-consumer|marketplace|wholesale',0,'SaaS,ecommerce'],
['jobs','Careers & Jobs','biz','\\bjobs?\\b|hiring|careers?\\b|recruit|salary|layoffs?|workplace|remote work',1,'careerguidance'],
['cyber','Cybersecurity','biz','cyber|hackers?|ransomware|data breach|malware|vulnerabilit',0,'cybersecurity,netsec'],
['india','India','pol','\\bindia\\b|\\bindian\\b|\\bdelhi\\b|\\bmumbai\\b|bengaluru|\\bmodi\\b|isro',1,'india'],
['world','World Affairs','pol','\\bwar\\b|ceasefire|united nations|summit|sanctions|diplomat|embassy|refugee|treaty|\\bnato\\b',0,'worldnews,geopolitics'],
['policy','Government & Policy','pol','government|govt|minister|parliament|policy|regulat|cabinet|ministry|election|tariffs?',1,'politics,policy'],
['local','Local News','pol','',1,''],
['law','Law & Courts','pol','\\bcourts?\\b|judge|lawsuit|verdict|tribunal|antitrust|attorney',1,'law'],
['defense','Defence & Security','pol','military|defen[cs]e|\\barmy\\b|\\bnavy\\b|air force|missile|armed forces',0,''],
['trending','Trending','pol','',0,''],
['science','Research & Science','sci','research|scientists?|researchers?|study finds|physics|biology|peer-reviewed|breakthrough',0,'science,Futurology'],
['space','Space','sci','nasa|\\bisro\\b|spacex|rocket|satellite|astronaut|\\bmars\\b|telescope',0,'space'],
['health','Health & Medicine','sci','health|hospital|vaccines?|disease|cancer|clinical trial|medicine|doctors?\\b',0,'health'],
['fitness','Fitness & Wellness','sci','fitness|workout|\\byoga\\b|nutrition|\\bdiet\\b|mental health|wellness|marathon',0,'fitness,running'],
['climate','Climate Change','sci','climate|emissions?|global warming|carbon|net zero|heatwave|wildfire|sea level',0,'climate,environment'],
['energy','Energy & Power','sci','solar|wind power|renewables?|\\boil\\b|opec|gas prices|nuclear|battery|power grid|hydrogen',0,'energy'],
['edu','Education','sci','education|universit|students?\\b|\\bexam|college|admission|scholarship|edtech|curriculum',1,'education'],
['auto','Automobile','ind','\\bcars?\\b|\\bevs?\\b|electric vehicles?|automakers?|carmakers?|\\bbmw\\b|mercedes|volkswagen|\\bvw\\b|tesla|toyota|tata motors|maruti|mahindra|hyundai|\\baudi\\b|porsche|automotive',0,'cars,electricvehicles'],
['agri','Agriculture','ind','agricultur|farm|\\bcrops?\\b|kisan|harvest|monsoon|fertili[sz]er|irrigation|\\bmandi\\b|\\bmsp\\b',1,'farming,agriculture'],
['realestate','Real Estate','ind','real estate|housing|property|home prices|mortgage|realty|construction',1,'realestate'],
['aviation','Aviation','ind','airlines?|aviation|airport|boeing|airbus|indigo|pilots?\\b',0,'aviation'],
['mfg','Manufacturing & Supply Chain','ind','manufactur|factory|supply chain|logistics|shipping|\\bports?\\b|exports?\\b|imports?\\b',0,''],
['ecom','E-commerce & Retail','ind','e-?commerce|amazon|flipkart|walmart|shopify|retail|online shopping',0,'ecommerce'],
['travel','Travel & Experiences','life','travel|tourism|tourists?|safari|destination|itinerary|backpack|resort|hotels?\\b|vacation',0,'travel,solotravel'],
['food','Food & Cooking','life','recipes?|restaurants?|\\bchef|cuisine|cooking|street food|michelin|foodie|baking',0,'food,cooking'],
['fashion','Fashion','life','fashion|runway|designers?\\b|couture|vogue|streetwear|ramp walk',0,'fashion,malefashionadvice'],
['beauty','Beauty & Skincare','life','beauty|skincare|makeup|cosmetics?|l.?oreal|sephora|nykaa|hair care|fragrance',0,'SkincareAddiction,MakeupAddiction'],
['parenting','Parenting & Family','life','parenting|parents\\b|\\bkids\\b|children|\\bbaby\\b|toddler|pregnan',0,'parenting'],
['pets','Pets & Animals','life','\\bpets?\\b|\\bdogs?\\b|\\bcats?\\b|puppy|wildlife|\\bzoo\\b|animal rescue',0,'pets'],
['spirit','Spirituality & Culture','life','spiritual|temple|meditation|festival|diwali|religio|pilgrim|astrolog',0,''],
['books','Books & Ideas','life','\\bbooks?\\b|author|novel|literature|bestseller|podcast|essay',0,'books'],
['vlog','Vlogging & Creators','life','vlog|creators?\\b|youtubers?|influencers?|instagram|tiktok|\\breels\\b|streamers?\\b',0,'NewTubers'],
['memes','Memes & Humor','life','\\bmemes?\\b|viral|funny|\\btrolls?\\b|humou?r|comedy|stand-up|parody',0,'memes,funny'],
['media','Media & Entertainment','ent','entertainment|celebrit|streaming|box office|actor|actress|trailer|\\bfilm|movie|tv show',0,'movies,television'],
['bollywood','Bollywood','ent','bollywood|hindi film|shah rukh|salman khan|aamir khan|deepika|alia bhatt|ranveer',0,'bollywood'],
['hollywood','Hollywood','ent','hollywood|\\boscars?\\b|marvel|disney|warner bros|netflix|academy awards|blockbuster|emmys?\\b',0,'movies'],
['korean','K-Pop & K-Drama','ent','k-?pop|k-?drama|korean|\\bbts\\b|blackpink|\\bhybe\\b|seoul|hallyu',0,'kpop,KDRAMA'],
['music','Music','ent','music|album|singers?\\b|concert|spotify|grammy|rapper|\\bsongs?\\b',0,'music'],
['gaming','Gaming & Esports','ent','gaming|gamers?\\b|playstation|xbox|nintendo|esports?|video games?',0,'gaming'],
['anime','Anime & Manga','ent','anime|manga|otaku|crunchyroll|ghibli',0,'anime'],
['ott','TV & OTT','ent','\\bott\\b|web series|prime video|disney plus|hotstar|tv series|sitcom|reality show',0,'television'],
['sports','Sports','spt','olympics?|tournament|championship|athletes?\\b|medal|\\bleague\\b',0,'sports'],
['cricket','Cricket','spt','cricket|\\bipl\\b|\\bbcci\\b|test match|\\bodi\\b|\\bt20|wicket|virat|rohit',0,'Cricket'],
['football','Football','spt','football|soccer|premier league|\\bfifa\\b|la liga|champions league|messi|ronaldo|\\buefa\\b',0,'soccer'],
['f1','Formula 1 & Motorsport','spt','formula 1|\\bf1\\b|grand prix|motogp|verstappen|hamilton|ferrari|nascar',0,'formula1'],
['basket','Basketball','spt','\\bnba\\b|basketball|lebron|wnba|euroleague',0,'nba'],
['tennis','Tennis','spt','tennis|wimbledon|grand slam|us open|\\batp\\b|\\bwta\\b|djokovic|alcaraz',0,'tennis']];
export const CAT=Object.fromEntries(CATS.map(c=>[c[0],c]));
export const LBL=Object.fromEntries(CATS.map(c=>[c[0],c[1]]));
export const GRP=Object.fromEntries(CATS.map(c=>[c[0],c[2]]));
// entertainment, sport and creator topics never leak into serious desks (Business, India...) on the public home page
export const ENTSPT=new Set(CATS.filter(c=>c[2]==='ent'||c[2]==='spt'||c[0]==='memes'||c[0]==='vlog').map(c=>c[0]));
export const CC='AD AE AF AG AI AL AM AN AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BU BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CS CU CV CW CX CY CZ DD DE DJ DK DM DO DY DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR FX GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU HV ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NH NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RH RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SU SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TP TR TT TV TW TZ UA UG UK US UY UZ VA VC VD VE VG VI VN VU WF WS XK YD YE YT YU ZA ZM ZR ZW';
export const ISO=new Set(CC.split(' '));
export const EUROPE=new Set('AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA'.split(' '));
export const QUICK=['IN','US','DE','EU','GB'];
const DN=new Intl.DisplayNames(['en'],{type:'region'});
export const cname=c=>{if(c==='EU')return'Europe';try{return DN.of(c)||c}catch{return c}};
