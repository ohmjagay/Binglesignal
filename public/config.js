// BingleSignal settings - the ONLY file you ever edit by hand.
window.BS={
  paywall:true,   // set to false to switch the trial/paywall gate off instantly (nobody is blocked)
  portalUrl:'',   // optional: your international payment provider's customer-portal link
  // ===== PRICING PAGE: edit the words here. Nothing else needs touching. =====
  // ONE plan, billed monthly through Razorpay. Everybody sees the same price: $5 a month.
  // In India the checkout step then shows that $5 in rupees at the live exchange rate plus GST (worker/src/pricing.js does the maths).
  // If you ever change the price, change it in THREE places: here, USD_PRICE in worker/src/pricing.js, and the amount of the Razorpay USD plan.
  price:{usd:5},
  plan:{
    heading:'One plan. The whole briefing.',
    note:'Free for 7 days, no card needed. Subscribe during your trial and the days you have left are added to your plan. Cancel any time.',
    name:'BingleSignal Briefing',
    label:'Daily briefing',
    tagline:"The signal from today's news, summarised for you, with videos picked for how you watch.",
    // One line per bullet. These are what a subscriber gets.
    features:[
      'A finite daily briefing, rebuilt every 6 hours around your interests and region',
      'READ: a clear summary of every story plus a "why it matters" line, with the original source one click away',
      'WATCH: video picks with a short note on what each one covers, ranked by what you actually watch',
      'A feed that learns what you like and shows you more of it, and less of what you don’t',
      'Stories are picked and summarised by AI, and every one links to its original source',
    ],
        // Things you are building but have not shipped. They show greyed out with a "soon" tag. Leave [] for none.
    soon:[
      'AI email and Gmail summariser for your inbox, so you can read the signal from your emails in minutes',
      'Cut 2-3 hours of daily email reading down to 10-15 minutes, and catch up on the go',
    ],
    // Small print under the price card. {usd} turns into your price ($5). The Refunds and Terms links are added after it automatically.
    fine:'One price worldwide: {usd} a month. In India you can pay the same price in rupees at the live exchange rate, and you see the exact total before you pay. If you pay in US dollars your bank may add its own exchange rate and fees. Payments are processed by PayPal and Razorpay.',
    // Shown under the "Pay in US dollars" button that visitors in India see. Leave '' to hide it.
    usdNote:'International card. Your bank may add its own exchange rate and fees, and some Indian cards block dollar payments.',
    // Questions and answers under the price card (like the FAQ on cardboard.ai/pricing). One ['question','answer'] pair per line, no comma after the last one. faq:[] hides the whole block.
    faqHeading:'Questions',
    faq:[
      ['Can I cancel any time?','Yes. Cancel from your Account page and you keep access until the end of the period you have already paid for.'],
      ['Is there a free trial?','Yes. Every new account starts with a 7-day free trial, and no card is needed to start it. If you subscribe while it is still running, the days you have left are added to your plan, so you lose none of them.'], ['When am I charged?','Nothing is charged during your free trial. If you subscribe while it is running, your first payment is taken on the day the trial ends, so you keep every free day, then every month until you cancel. If your trial has already ended, you are charged when you subscribe. If you are not satisfied, email us within 7 days of your first payment for a full refund.'],
      ['How do I pay?','The first option is PayPal: {usd} a month in US dollars. Under Choose another option, outside India you pay {usd} a month by international card, and in India you can choose rupees or US dollars.'],
      ['How is the rupee price worked out?','{usd} is converted at the exchange rate on the day you subscribe and rounded up to the next 5 rupees. That rupee amount then stays the same every month.']
    ]
  },
  // ===== WHAT IS FREE AND WHAT IS PAID (shown as a table on the pricing page) =====
  // One row per line: [what you get, free for everyone, included with the plan]. 1 = yes, 0 = no. {readCap} and {watchCap} become the numbers below.
  compare:{
    headings:['Free, no sign-up','7-day trial, then $5 a month'],
    rows:[
      ['The top stories of the day, each linked to its original source',1,1],
      ['One full story summary every day: what happened and why it matters',1,1],
      ['READ: up to {readCap} stories ranked for you, every one summarised',0,1],
      ['WATCH: up to {watchCap} video picks with a note on what each covers',0,1],
      ['A feed that learns from what you like, save and skip',0,1],
      ['Your interests and region kept on every device you sign in on',0,1],
    ],
  },
  // ===== SOCIAL PROOF: add this only when it is TRUE. Leave '' and [] to hide it. =====
  // proof: one line shown under the headline, for example 'Read by 250 professionals in 12 countries'.
  // reviews: real words from real readers, with their permission. Example: {quote:'I read it with my coffee and I am done by 9.', name:'Priya S.', role:'Product manager, Bengaluru'}
  proof:'',
  reviews:[],
  // ===== ABOUT PAGE (/about): the person behind BingleSignal. Fill these in and the page shows them automatically. =====
  // photo: put your picture in the public folder, for example public/hari.jpg, and write 'hari.jpg' here. story: a few short paragraphs, separate them with a blank line.
  about:{ name:'', role:'Founder, BingleSignal', photo:'', linkedin:'', story:'' },
  emailBeta:false,  // the invited email beta is paused; set true (and EMAIL_BETA_ENABLED=true in Cloudflare) to bring its tab back
 
 supabaseUrl:'https://bpgstmqbbvvlibgcssvq.supabase.co',
 supabaseKey:'sb_publishable_A6eZtpdfkTkpID-kwzpW5w_edwnLOxa', // public "publishable" key: safe to publish. NEVER paste a service_role key here.
 turnstileSiteKey:'0x4AAAAAAF1xufF2REJahy8J', // public Cloudflare Turnstile site key; set after adding CAPTCHA in Supabase Auth.
 readCap:200,  // stories in READ (same for every subscriber: there is one plan)
 watchCap:200,  // videos in WATCH
 company:'BingleSignal',
 city:'Jaipur, India',   // shown at the bottom of every page next to the company name. Leave '' to hide.
 operator:'',            // optional: who runs it, for example 'Operated by Your Full Name'. Shown at the bottom of every page. Leave '' to hide.
 site:'https://binglesignal.com',
 // Fill these in later (leave '' to hide). A full link (https://...) or just the handle both work.
 // Example: email:'hello@binglesignal.com', x:'binglesignal', linkedin:'binglesignal', instagram:'binglesignal', youtube:'binglesignal', whatsapp:'https://whatsapp.com/channel/...'
 email:'support@binglesignal.com', x:'', linkedin:'https://www.linkedin.com/company/binglesignal/', instagram:'', youtube:'', whatsapp:''
};
