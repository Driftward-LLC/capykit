import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.CAPYKIT_CONSOLE_URL ?? 'http://127.0.0.1:4177';
const browser = await chromium.launch({headless:true,...(process.env.CAPYKIT_CHROMIUM_PATH ? {executablePath:process.env.CAPYKIT_CHROMIUM_PATH} : {})});
const errors = [], results = [];
try {
 for (const width of [320,390,1440]) {
  const context = await browser.newContext({viewport:{width,height:844}});
  const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  let signedIn=false, denial=false, unavailable=false, methodUnavailable=false, attempts=0;
  const requests=[];
  await page.route('**/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname;requests.push(path);
   let status=200,body={};
   if(path==='/v1/me') { status=signedIn?200:401;body=signedIn?{identity:{email:'owner@example.test',principalKind:'human'},workspace:{id:'workspace',role:'owner'}}:{error:{code:'AUTHENTICATION_REQUIRED'}}; }
   else if(path==='/v1/auth/method') {status=methodUnavailable?503:200;body={method:'tailscale'};}
   else if(path==='/v1/auth/tailscale') { attempts++;status=unavailable?503:denial?401:200;signedIn=status===200;body=status===200?{status:'authenticated'}:{error:{code:'AUTHENTICATION_INVALID'}}; }
   else if(path==='/v1/auth/logout') { signedIn=false;body={status:'signed_out'}; }
   else if(path==='/v1/apps') body={apps:[],github:[],google:{configured:false,connection:null}};
   else if(path==='/v1/connections') body={configured:false,connections:[],installationUrl:null,setup:null};
   else if(path==='/v1/capabilities') body={capabilities:[]};
   else if(path==='/v1/access/options') body={principals:[],connections:[],capabilities:[]};
   else if(path==='/v1/grants') body={grants:[],nextCursor:null};
   await route.fulfill({status,json:body});
  });
  await page.goto(origin);await page.getByRole('heading',{name:'Apps',exact:true}).waitFor();
  assert.equal(attempts,1);assert.equal(await page.getByLabel('Invited email address').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.reload();await page.getByRole('heading',{name:'Apps',exact:true}).waitFor();assert.equal(attempts,1);
  await page.getByRole('button',{name:'Functions',exact:true}).click();await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();
  await page.getByRole('button',{name:'Access',exact:true}).click();await page.getByRole('heading',{name:'Access',exact:true}).waitFor();
  methodUnavailable=true;
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Continue with Tailscale',exact:true}).waitFor();
  assert.equal(signedIn,false);assert.equal(attempts,1);methodUnavailable=false;
  assert.equal(await page.getByLabel('Six-digit sign-in code').count(),0);
  await page.getByRole('button',{name:'Continue with Tailscale',exact:true}).click();await page.getByRole('heading',{name:'Access',exact:true}).waitFor();assert.equal(attempts,2);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Continue with Tailscale',exact:true}).waitFor();
  denial=true;await page.getByRole('button',{name:'Continue with Tailscale',exact:true}).click();await page.getByText('This device’s Tailscale identity does not have access to this workspace.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Invited email address').count(),0);
  denial=false;unavailable=true;await page.getByRole('button',{name:'Continue with Tailscale',exact:true}).click();await page.getByText('Could not check your session. Check your connection and retry.',{exact:true}).waitFor();
  unavailable=false;await page.getByRole('button',{name:'Continue with Tailscale',exact:true}).click();await page.getByRole('heading',{name:'Access',exact:true}).waitFor();
  // Loading with an already valid cookie must still learn the deployment's sign-in mode.
  await page.reload();await page.getByRole('heading',{name:'Access',exact:true}).waitFor();
  signedIn=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByRole('button',{name:'Continue with Tailscale',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Invited email address').count(),0);
  assert.ok(!requests.includes('/v1/auth/otp'));assert.ok(!requests.includes('/v1/auth/verify'));
  results.push({width,codeFreeFirstVisit:true,rememberedReload:true,logoutAndContinue:true,denialAndRetry:true,existingSessionExpiry:true,logoutDuringMethodOutage:true,noOverflow:true});await context.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,results}));
} finally {await browser.close();}
