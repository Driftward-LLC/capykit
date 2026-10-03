import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const {chromium}=await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const directory=resolve(process.env.CAPYKIT_CONSOLE_DIR ?? 'dist/console');
const origin='https://capykit.example.test';
const browser=await chromium.launch({headless:true,...(process.env.CAPYKIT_CHROMIUM_PATH?{executablePath:process.env.CAPYKIT_CHROMIUM_PATH}:{}),args:['--no-sandbox']});
const results=[];
try {
 for(const width of [320,390,1440]) {
  const context=await browser.newContext({viewport:{width,height:844},isMobile:width<641,hasTouch:width<641});
  await context.addCookies([{name:'capykit_csrf',value:'private-proof',url:origin},{name:'capykit_public_csrf',value:'public-proof',url:origin}]);
  const page=await context.newPage();const errors=[],requests=[];
  let signedIn=false,available=true,startUnavailable=false,expired=false,renewals=0;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   try {
    const url=new URL(route.request().url());requests.push(url.pathname);
    if(url.origin==='https://accounts.google.com')return route.fulfill({contentType:'text/html',body:'<h1>Google fixture</h1>'});
    assert.equal(url.origin,origin);
    if(route.request().method()==='POST')assert.equal(route.request().headers()['x-csrf-token'],'public-proof');
    const json=(body,status=200)=>route.fulfill({status,json:body});
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:await readFile(directory+'/index.html')});
    if(url.pathname.startsWith('/assets/'))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:await readFile(directory+url.pathname)});
    if(url.pathname==='/v1/auth/method')return json({method:'google',available});
    if(url.pathname==='/v1/me')return signedIn&&!expired?json({identity:{email:'customer@example.test',principalKind:'human'},workspace:{id:'customer-workspace',role:'owner'}}):json({error:{code:'AUTHENTICATION_REQUIRED'}},401);
    if(url.pathname==='/v1/auth/refresh'){if(signedIn&&expired){expired=false;renewals++;return json({status:'authenticated'});}return json({error:{code:'AUTHENTICATION_REQUIRED'}},401);}
    if(url.pathname==='/v1/auth/google/start')return startUnavailable?json({error:{code:'AUTH_UNAVAILABLE'}},503):json({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'});
    if(url.pathname==='/v1/auth/logout'){signedIn=false;return json({status:'signed_out'});}
    if(url.pathname==='/v1/apps')return json({apps:[],github:[],google:{configured:false,connection:null}});
    if(url.pathname==='/v1/connections')return json({configured:false,connections:[],installationUrl:null,setup:null});
    if(url.pathname==='/v1/capabilities')return json({capabilities:[]});
    if(url.pathname==='/v1/access/options')return json({users:[],connections:[],versions:[],truncated:false});
    if(url.pathname==='/v1/grants')return json({grants:[],nextCursor:null});
    throw Error(`Unexpected ${url.pathname}`);
   }catch(e){errors.push(e.message);await route.abort();}
  });
  await page.goto(origin);await page.getByRole('button',{name:'Continue with Google',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Invited email address').count(),0);
  assert.equal(await page.getByLabel('Six-digit sign-in code').count(),0);
  assert.equal(await page.getByRole('button',{name:'Continue with Tailscale'}).count(),0);
  assert.equal(await page.getByText('Create your own workspace. No invitation needed.',{exact:true}).count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok((await page.getByRole('button',{name:'Continue with Google'}).boundingBox()).height>=44);
  await page.screenshot({path:`/tmp/capykit-public-signup-${width}.png`,fullPage:true});
  startUnavailable=true;await page.getByRole('button',{name:'Continue with Google'}).click();await page.getByRole('alert').waitFor();
  assert.ok(await page.getByRole('button',{name:'Continue with Google'}).isEnabled());startUnavailable=false;
  await page.getByRole('button',{name:'Continue with Google'}).click();await page.waitForURL('https://accounts.google.com/**');
  for(const state of ['google-cancelled','google-expired','google-failed']) {
   await page.goto(origin+'/?auth='+state);await page.getByRole('alert').waitFor();
   assert.equal(new URL(page.url()).searchParams.has('auth'),false);
   assert.ok(await page.getByRole('button',{name:'Continue with Google'}).isEnabled());
  }
  available=false;await page.goto(origin);await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Continue with Google'}).count(),0);
  assert.equal(await page.getByText(/administrator|operator|Console/).count(),0);
  available=true;await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('button',{name:'Continue with Google'}).waitFor();
  // Fixture callback represents a newly provisioned workspace; real OAuth is tested separately.
  signedIn=true;await page.goto(origin+'/?tab=connections');await page.getByRole('heading',{name:'Apps',exact:true}).waitFor();
  expired=true;await page.reload();await page.getByRole('heading',{name:'Apps',exact:true}).waitFor();assert.equal(renewals,1);
  await page.getByRole('button',{name:'Functions',exact:true}).click();await page.getByRole('heading',{name:'Functions & skills'}).waitFor();
  await page.getByRole('button',{name:'Access',exact:true}).click();await page.getByRole('heading',{name:'Access',exact:true}).waitFor();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Continue with Google'}).waitFor();
  if(width<641){await page.setViewportSize({width,height:420});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  assert.ok(!requests.includes('/v1/auth/otp')&&!requests.includes('/v1/auth/verify')&&!requests.includes('/v1/auth/tailscale'));
  assert.deepEqual(errors,[]);results.push({width,passed:true});await context.close();
 }
 console.log(JSON.stringify({passed:true,results}));
}finally{await browser.close();}
