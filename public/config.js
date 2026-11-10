// BingleSignal settings - the ONLY file you ever edit by hand.
window.BS={
  paywall:true,   // set to false to switch the trial/paywall gate off instantly (nobody is blocked)
  portalUrl:'',   // optional: your international payment provider's customer-portal link
  // ONE plan: BingleSignal Briefing, billed monthly through Razorpay. The pricing page shows these amounts, so create the
  // Razorpay plans (one INR, one USD) with exactly the same amounts.
  prices:{
   IN:{c:'₹',month:'299'},
   GL:{c:'$',month:'5'}
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
