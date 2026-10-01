import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = resolve(process.env.CAPYKIT_CONSOLE_DIR ?? 'dist/console');
const prefix = resolve(process.env.CAPYKIT_BROWSER_ARTIFACT_PREFIX ?? '/tmp/capykit-mobile');
const origin = 'https://capykit.example.test';
const options = { users: [{ id: 'user', name: 'Alex', email: 'alex@example.test', role: 'member' }], versions: [{ capabilityId: 'skill', name: 'Review guide', kind: 'skill', version: '1.0.0', operation: null }, { capabilityId: 'function', name: 'Read issues', kind: 'function', version: '2.0.0', operation: 'github.issues.list.v1' }], connections: [{ id: 'connection', name: 'example', repositories: [{ id: '101', name: 'example/a-long-repository-name-for-phone-layout-verification' }, { id: '102', name: 'example/second' }] }], truncated: false };
const capability = { id: 'skill', name: 'Review guide with a long name for phone layout verification', slug: 'review-guide', kind: 'skill', createdAt: '2026-01-01T00:00:00Z' };
const detail = { ...capability, draft: null, versions: [{ version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', digest: 'sha256:fixture', fileCount: 1, byteCount: 100, contract: null, files: [{ path: 'SKILL.md', executable: false, byteLength: 100, sha256: 'fixture' }] }] };
const browser = await chromium.launch({ ...(process.env.CAPYKIT_CHROMIUM_PATH ? { executablePath: process.env.CAPYKIT_CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
const results = [];
async function check(width) {
 const context = await browser.newContext({viewport:{width,height:844},isMobile:width<641,hasTouch:width<641});
 await context.addCookies([{name:'capykit_csrf',value:'csrf-test',url:origin}]);
 const page=await context.newPage();const errors=[];let signedIn=false;
 page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
  try {
   const req=route.request(),url=new URL(req.url());assert.equal(url.origin,origin);
   const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:await readFile(directory+'/index.html')});
   if(url.pathname.startsWith('/assets/'))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:await readFile(directory+url.pathname)});
   if(url.pathname==='/v1/me')return signedIn?json({identity:{email:'long-account-name@example.test',principalKind:'human'},workspace:{id:'workspace',role:'owner'}}):json({error:{code:'AUTHENTICATION_REQUIRED'}},401);
   if(url.pathname==='/v1/auth/refresh')return json({error:{code:'AUTHENTICATION_REQUIRED'}},401);
   if(url.pathname==='/v1/auth/otp')return json({});
   if(url.pathname==='/v1/auth/verify'){signedIn=true;return json({});}
   if(url.pathname==='/v1/capabilities')return json({capabilities:[capability]});
   if(url.pathname==='/v1/capabilities/skill')return json(detail);
   if(url.pathname==='/v1/apps')return json({apps:[{id:'github',name:'GitHub',configured:true,connected:false,description:'Read issues'}],github:[],google:{configured:false,connection:null}});
   if(url.pathname==='/v1/connections')return json({configured:true,setup:null,installationUrl:'https://github.com/apps/example/installations/new',connections:[]});
   if(url.pathname.startsWith('/v1/connections/github/pending/'))return json({setupId:'12345678-1234-1234-1234-123456789abc',connectionId:'pending',expiresAt:'2030-01-01T00:00:00Z',candidates:[{installationId:'10',account:{id:'20',login:'example',type:'Organization'},repositories:options.connections[0].repositories.map(r=>({id:r.id,fullName:r.name,url:'https://github.com/'+r.name,admin:true}))}]});
   if(url.pathname==='/v1/access/options')return json(options);
   if(url.pathname==='/v1/grants')return json({grants:[{id:'grant',recipientName:'Alex',capabilityName:'Read issues',version:'2.0.0',action:'invoke',connectionName:'example',repositories:options.connections[0].repositories,repositoryIds:['101','102'],expiresAt:'2030-01-01T00:00:00Z',status:'active'}],nextCursor:null});
   throw Error(`Unexpected ${req.method()} ${url.pathname}`);
  }catch(e){errors.push(e.message);await route.abort();}
 });
 async function layout(step) {
  await page.screenshot({path:`${prefix}-${width}-${step}.png`,fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`${width} ${step}: page overflow`);
  const failures=await page.evaluate(()=>[...document.querySelectorAll('button, a.button-link, summary, input:not([type="checkbox"]), select')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden').flatMap(e=>{
   const r=e.getBoundingClientRect(),s=getComputedStyle(e),name=e.textContent?.trim().slice(0,60)||e.getAttribute('type');
   const bad=[];if(r.height<43.9)bad.push(`${name}: height ${r.height}`);
   if(e.matches('input,select')&&parseFloat(s.fontSize)<16)bad.push(`${name}: font ${s.fontSize}`);return bad;
  }));assert.deepEqual(failures,[],`${width} ${step}: touch/text dimensions`);
 }
 try {
  await page.goto(origin);await page.getByLabel('Invited email address').waitFor();await layout('sign-in');
  await page.getByLabel('Invited email address').fill('owner@example.test');await page.getByRole('button',{name:'Send sign-in code',exact:true}).click();
  const otp=page.getByLabel('Six-digit sign-in code');await otp.waitFor();assert.equal(await otp.getAttribute('inputmode'),'numeric');assert.equal(await otp.getAttribute('autocomplete'),'one-time-code');await layout('otp');
  await otp.fill('123456');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Functions',exact:true}).click();await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();
  await page.getByRole('button',{name:'New capability'}).click();await page.getByRole('heading',{name:'Create a capability'}).waitFor();await layout('create');
  const identifier=page.getByLabel('Identifier',{exact:true});assert.equal(await identifier.getAttribute('autocapitalize'),'none');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button').filter({hasText:capability.name}).click();await page.getByRole('button',{name:'Download 1.0.0'}).waitFor();await layout('detail');
  await page.getByRole('button',{name:'Apps',exact:true}).click();await page.locator('.app-row').filter({hasText:'GitHub'}).click();await page.getByRole('button',{name:'Continue with GitHub',exact:true}).waitFor();await layout('connections');
  await page.goto(origin+'/?tab=connections&setup=12345678-1234-1234-1234-123456789abc');
  await page.getByRole('checkbox',{name:options.connections[0].repositories[0].name,exact:true}).waitFor();await layout('repository-review');
  await page.getByRole('button',{name:'Access',exact:true}).click();await page.getByLabel('User',{exact:true}).selectOption('user');await page.getByLabel('Published capability version').selectOption('function:2.0.0');await page.getByLabel('GitHub connection',{exact:true}).selectOption('connection');
  const repo=page.getByRole('checkbox',{name:options.connections[0].repositories[0].name,exact:true});await repo.check();assert.ok((await repo.locator('..').boundingBox()).height>=44);
  const consent=page.getByRole('checkbox',{name:/^I grant/});await consent.focus();await page.keyboard.press('Space');assert.ok(await page.getByRole('button',{name:'Grant access',exact:true}).isEnabled());await layout('access');
  await page.getByRole('button',{name:'Revoke access for Alex'}).click();await page.getByRole('button',{name:'Confirm revoke'}).waitFor();await layout('revoke');
  if(width<641){
   await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));const nav=await page.getByRole('navigation',{name:'Workspace',exact:true}).boundingBox();assert.ok(nav.y+nav.height>=page.viewportSize().height-1&&nav.y>=0,'navigation remains reachable while scrolling');
   await page.getByRole('button',{name:'Functions',exact:true}).click();await page.getByRole('button',{name:'New capability'}).click();await page.getByLabel('Name',{exact:true}).focus();
   await page.setViewportSize({width,height:420});await page.getByLabel('Name',{exact:true}).scrollIntoViewIfNeeded();await layout('short-viewport');
  }
  assert.deepEqual(errors,[]);results.push({width,passed:true});console.log(`PASS ${width}px: sign-in, OTP, create, detail, connections, grants, revoke, touch/text dimensions`);
 }finally{await context.close();}
}
try{for(const width of [320,375,390,430,1440])await check(width);}finally{await writeFile(`${prefix}-results.json`,JSON.stringify(results,null,2));await browser.close();}
