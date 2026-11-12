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
    note:'Every account starts with a 7-day free trial. No card needed. Cancel any time.',
    name:'BingleSignal Briefing',
    label:'Daily briefing',
    tagline:"The signal from today's news, summarised for you, with videos picked for how you watch.",
    // One line per bullet. These are what a subscriber gets.
    features:[
      'A finite daily briefing, rebuilt every 6 hours around your interests and region',
      'READ: a clear summary of every story plus a "why it matters" line, with the original source one click away',
      'WATCH: video picks with a short note on what each one covers, ranked by what you actually watch',
      'A feed that learns from every like, save, hide, skip and watch'
    ],
    // Things you are building but have not shipped. They show greyed out with a "soon" tag. Leave [] for none.
    soon:[]
  },
  emailBeta:false,  // the invited email beta is paused; set true (and EMAIL_BETA_ENABLED=true in Cloudflare) to bring its tab back
 
 supabaseUrl:'https://bpgstmqbbvvlibgcssvq.supabase.co',
 supabaseKey:'sb_publishable_A6eZtpdfkTkpID-kwzpW5w_edwnLOxa', // public "publishable" key: safe to publish. NEVER paste a service_role key here.
 turnstileSiteKey:'0x4AAAAAAF1xufF2REJahy8J', // public Cloudflare Turnstile site key; set after adding CAPTCHA in Supabase Auth.
 readCap:200,  // stories in READ (same for every subscriber: there is one plan)
 watchCap:30,  // videos in WATCH
 company:'BingleSignal',
 // Fill these in later (leave '' to hide). Example: email:'hello@binglesignal.com', x:'binglesignal', linkedin:'binglesignal', instagram:'binglesignal', youtube:'binglesignal'
 email:'support@binglesignal.com', x:'', linkedin:'https://www.linkedin.com/company/binglesignal/', instagram:'', youtube:''
};
