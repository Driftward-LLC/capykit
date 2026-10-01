// Start the console with: npx vite src/console --host 127.0.0.1 --port 4174
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const origin=process.env.CAPYKIT_CONSOLE_URL ?? 'http://127.0.0.1:4174';
import {mkdir,writeFile} from 'node:fs/promises';
const evidence='/tmp/capykit-app-browser';await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CAPYKIT_CHROMIUM_PATH ? {executablePath:process.env.CAPYKIT_CHROMIUM_PATH}: {})});
const errors=[];const results=[];
const connection={id:'11111111-1111-4111-8111-111111111111',status:'active',account:{id:'1',login:'Example workspace',type:'Organization'},installationId:'1',repositories:[{id:'11',fullName:'example/repository',url:'https://github.com/example/repository'}],permissions:{issues:'read',metadata:'read'},consentAt:new Date().toISOString(),consentByPrincipalId:'owner',updatedAt:new Date().toISOString(),createdAt:new Date().toISOString()};
try {
for(const width of [320,390,430,1440]){
 const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 let configured=false;
 await page.route('**/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;let body={};
  if(path==='/v1/me')body={identity:{email:'owner@example.test',principalKind:'human'},workspace:{id:'workspace',role:'owner'}};
  else if(path==='/v1/apps')body={apps:[{id:'github',name:'GitHub',configured:true,connected:true,description:'Read issues from selected repositories'},{id:'google-drive',name:'Google Drive',configured,connected:false,description:'Read file names and metadata'}],github:[connection],google:{configured,connection:null}};
  else if(path==='/v1/connections')body={configured:true,connections:[connection],installationUrl:'https://github.com/apps/example/installations/new',setup:null};
  else if(path==='/v1/capabilities')body={capabilities:[]};
  else if(path==='/v1/access/options')body={principals:[],connections:[],capabilities:[]};
  else if(path==='/v1/grants')body={grants:[],nextCursor:null};
  else if(path==='/v1/apps/github/test')body={result:{number:12,title:'Mobile connection check',state:'open'}};
  else if(path.startsWith('/v1/connections/'))body=connection;
  await route.fulfill({json:body});
 });
 await page.goto(origin);await page.getByRole('heading',{name:'Apps',exact:true}).waitFor();
 await page.getByRole('button',{name:/GitHub.*Connected/}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:`${evidence}/apps-${width}.png`,fullPage:true});
 await page.getByLabel('Search apps').fill('drive');assert.equal(await page.getByRole('button',{name:/GitHub.*Connected/}).count(),0);
 await page.getByRole('button',{name:/Google Drive.*Not available yet/}).click();await page.getByRole('heading',{name:'Google Drive isn’t available yet',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Connect Google Drive',exact:true}).count(),0);
 await page.reload();await page.getByRole('heading',{name:'Google Drive isn’t available yet',exact:true}).waitFor();
 await page.getByRole('button',{name:'Check availability',exact:true}).click();await page.getByText('Google Drive is still unavailable. Your administrator needs to finish setup.',{exact:true}).waitFor();
 configured=true;await page.getByRole('button',{name:'Check availability',exact:true}).click();await page.getByText('Google Drive is ready. Connect your account below.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Connect Google Drive',exact:true}).isEnabled(),true);
 assert.equal(await page.getByRole('checkbox').count(),0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:`${evidence}/google-connect-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'← All apps',exact:true}).click();await page.getByLabel('Search apps').fill('');
 await page.getByRole('button',{name:'Connected',exact:true}).click();assert.equal(await page.getByRole('button',{name:/Google Drive/}).count(),0);
 await page.getByRole('button',{name:/GitHub.*Connected/}).click();await page.getByRole('heading',{name:'Try your connection'}).waitFor();
 await page.getByLabel('Issue number').fill('12');await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.getByText('Mobile connection check',{exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:`${evidence}/github-test-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'← All apps',exact:true}).click();await page.getByRole('button',{name:'＋ Create a function',exact:true}).click();
 await page.getByRole('heading',{name:'Create a capability',exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:/^Kind/}).inputValue(),'function');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const small=await page.locator('input:not([type="checkbox"]),select,button').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden').filter(n=>n.getBoundingClientRect().height<44).map(n=>n.textContent));assert.deepEqual(small,[]);
 if(width<641){const nav=await page.getByRole('navigation',{name:'Workspace',exact:true}).boundingBox();assert.ok(nav.y+nav.height>=899);}
 results.push({width,search:true,filter:true,configurationState:true,githubRead:true,functionForm:true,noOverflow:true});await context.close();
}
assert.deepEqual(errors,[]);await writeFile(`${evidence}/results.json`,JSON.stringify({results,errors},null,2));console.log(JSON.stringify({passed:true,results}));
}finally{await browser.close();}
