// BingleSignal settings - the ONLY file you ever edit by hand.
window.BS={
  paywall:true,   // set to false to switch the trial/paywall gate off instantly (nobody is blocked)
  portalUrl:'',   // optional: your international payment provider's customer-portal link
  prices:{
   IN:{c:'₹',lite:{month:'299',year:'2,999'},pro:{month:'799',year:'7,999'}},
   GL:{c:'$',lite:{month:'5',year:'50'},pro:{month:'11',year:'110'}}
  },
 
 supabaseUrl:'https://bpgstmqbbvvlibgcssvq.supabase.co',
 supabaseKey:'sb_publishable_A6eZtpdfkTkpID-kwzpW5w_edwnLOxa', // public "publishable" key: safe to publish. NEVER paste a service_role key here.
 turnstileSiteKey:'0x4AAAAAAF1xufF2REJahy8J', // public Cloudflare Turnstile site key; set after adding CAPTCHA in Supabase Auth.
 readCap:200,  // stories in READ
 watchCap:30,  // videos in WATCH
 company:'BingleSignal',
 // Fill these in later (leave '' to hide). Example: email:'hello@binglesignal.com', x:'binglesignal', linkedin:'binglesignal', instagram:'binglesignal', youtube:'binglesignal'
 email:'support@binglesignal.com', x:'', linkedin:'https://www.linkedin.com/company/binglesignal/', instagram:'', youtube:''
};
