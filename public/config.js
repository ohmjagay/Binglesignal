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
    note:'Start reading straight away. Cancel any time. Full refund within 7 days of your first payment.',
    name:'BingleSignal Briefing',
    label:'Daily briefing',
    tagline:"The signal from today's news, summarised for you, with videos picked for how you watch.",
    // One line per bullet. These are what a subscriber gets.
    features:[
      'A finite daily briefing, Rebuilt every 6 hours around your interests and region',
      'READ: A clear summary of every story plus a "why it matters" line, with the original source one click away',
      'WATCH: video picks with a short note on what each one covers, ranked by what you actually watch',
      'A feed that learns what you like and shows you more of it, and less of what you don’t',
      'Content Picked and Summarised by AI and human editors, with a focus on what matters to you',
    ],
        // Things you are building but have not shipped. They show greyed out with a "soon" tag. Leave [] for none.
    soon:[
      'AI Email/Gmail summarizer for your inbox, so you can read the signal from your emails in minutes',
      'Users who are spending 2-3 hours daily to read emails will be reduced to 10-15 minutes, and they will be able to read the signal from their emails on the go',
    ],
    // Small print under the price card. {usd} turns into your price ($5). The Refunds and Terms links are added after it automatically.
    fine:'One price worldwide: {usd} a month. In India you can pay the same price in rupees at the live exchange rate, and you see the exact total before you pay. If you pay in US dollars your bank may add its own exchange rate and fees. Payments are processed by Razorpay.',
    // Shown under the "Pay in US dollars" button that visitors in India see. Leave '' to hide it.
    usdNote:'International card. Your bank may add its own exchange rate and fees, and some Indian cards block dollar payments.',
    // Questions and answers under the price card (like the FAQ on cardboard.ai/pricing). One ['question','answer'] pair per line, no comma after the last one. faq:[] hides the whole block.
    faqHeading:'Questions',
    faq:[
      ['Can I cancel any time?','Yes. Cancel from your Account page and you keep access until the end of the period you have already paid for.'],
      ['When am I charged?','The moment you subscribe, then every month until you cancel. If you are not satisfied, email us within 7 days of your first payment for a full refund.'],
      ['How do I pay?','Outside India you pay {usd} a month by international card. In India you can choose rupees or US dollars.'],
      ['How is the rupee price worked out?','{usd} is converted at the exchange rate on the day you subscribe and rounded up to the next 5 rupees. That rupee amount then stays the same every month.']
    ]
  },
  emailBeta:false,  // the invited email beta is paused; set true (and EMAIL_BETA_ENABLED=true in Cloudflare) to bring its tab back
 
 supabaseUrl:'https://bpgstmqbbvvlibgcssvq.supabase.co',
 supabaseKey:'sb_publishable_A6eZtpdfkTkpID-kwzpW5w_edwnLOxa', // public "publishable" key: safe to publish. NEVER paste a service_role key here.
 turnstileSiteKey:'0x4AAAAAAF1xufF2REJahy8J', // public Cloudflare Turnstile site key; set after adding CAPTCHA in Supabase Auth.
 readCap:200,  // stories in READ (same for every subscriber: there is one plan)
 watchCap:200,  // videos in WATCH
 company:'BingleSignal',
 // Fill these in later (leave '' to hide). Example: email:'hello@binglesignal.com', x:'binglesignal', linkedin:'binglesignal', instagram:'binglesignal', youtube:'binglesignal'
 email:'support@binglesignal.com', x:'', linkedin:'https://www.linkedin.com/company/binglesignal/', instagram:'', youtube:''
};
