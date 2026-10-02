// Run against a local console preview. Provider responses are controlled fixtures.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const origin=process.env.CAPYKIT_CONSOLE_URL ?? 'http://127.0.0.1:4174';
const browser=await chromium.launch({headless:true,...(process.env.CAPYKIT_CHROMIUM_PATH?{executablePath:process.env.CAPYKIT_CHROMIUM_PATH}:{})});
const id='11111111-1111-4111-8111-111111111111';
const repo={id:'123',fullName:'example/repository',admin:true,url:'https://github.com/example/repository'};
const setup={setupId:id,connectionId:id,candidates:[{installationId:'1',account:{id:'1',login:'Example',type:'Organization'},repositories:[repo]}],expiresAt:new Date(Date.now()+600000).toISOString()};
const connection={id,status:'pending',account:null,repositories:[],permissions:{issues:'read',metadata:'read'},consentAt:null,updatedAt:new Date().toISOString()};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const results=[];
try {
 for(const width of [390,1440]) for(const callback of [false,true]) for(const destination of ['drive','catalog','Functions','Access']) {
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
  const started=deferred(),release=deferred(),errors=[];let setupRequests=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/v1/**',async route=>{
   if(route.request().resourceType()==='document')return route.continue();
   const path=new URL(route.request().url()).pathname;let body={};
   if(path==='/v1/me')body={identity:{email:'owner@example.test',principalKind:'human'},workspace:{id:'workspace',role:'owner'}};
   else if(path==='/v1/apps')body={apps:[{id:'github',name:'GitHub',configured:true,connected:false,description:'Read issues'},{id:'google-drive',name:'Google Drive',configured:true,connected:false,description:'Read metadata'}],github:[connection],google:{configured:true,connection:null}};
   else if(path==='/v1/connections')body={configured:true,connections:[connection],installationUrl:'https://github.com/apps/example/installations/new',setup:null};
   else if(path===`/v1/connections/github/pending/${id}`||path==='/v1/connections/github/callback'){setupRequests++;started.resolve();await release.promise;body=setup;}
   else if(path==='/v1/capabilities')body={capabilities:[]};
   else if(path==='/v1/grants')body={grants:[],nextCursor:null};
   else if(path==='/v1/access/options')body={principals:[],capabilities:[],connections:[]};
   await route.fulfill({json:body});
  });
  try {
   await page.goto(callback?`${origin}/v1/connections/github/callback?code=fixture-code&state=fixture-state`:`${origin}/?tab=connections&setup=${id}`);
   await started.promise;
   if(destination==='drive'||destination==='catalog'){
    await page.getByRole('button',{name:'← All apps',exact:true}).click();
    if(destination==='drive')await page.getByRole('button',{name:/Google Drive.*Ready to connect/}).click();
   }else await page.getByRole('button',{name:destination,exact:true}).click();
   const navigation=page.url();release.resolve();
   // The hidden review heading proves the delayed response reached React.
   await page.getByRole('heading',{name:'Choose repositories for this workspace',exact:true,includeHidden:true}).waitFor({state:'attached'});
   assert.equal(page.url(),navigation,`late GitHub response changed ${destination} navigation (${width}px, callback=${callback})`);
   if(destination==='Functions'||destination==='Access')await page.getByRole('button',{name:'Apps',exact:true}).click();
   if(destination!=='catalog')await page.getByRole('button',{name:'← All apps',exact:true}).click();
   await page.getByRole('button',{name:/GitHub.*Ready to connect/}).click();
   await page.getByRole('heading',{name:'Choose repositories for this workspace',exact:true}).waitFor();
   await page.waitForFunction(setupId=>new URL(location.href).searchParams.get('setup')===setupId,id);
   assert.equal(setupRequests,1,'returning to GitHub must resume without replaying the callback or setup request');
   await page.getByRole('button',{name:'← All apps',exact:true}).click();await page.getByRole('button',{name:/Google Drive.*Ready to connect/}).click();
   await page.reload();await page.getByRole('heading',{name:'Connect Google Drive',exact:true}).waitFor();
   assert.equal(new URL(page.url()).searchParams.has('setup'),false);assert.equal(new URL(page.url()).searchParams.get('app'),'google-drive');
   // Old bookmarked URLs containing both parameters must honor the selected app.
   await page.goto(`${origin}/?tab=connections&app=google-drive&setup=${id}`);
   await page.getByRole('heading',{name:'Connect Google Drive',exact:true}).waitFor();
   assert.deepEqual(errors,[]);results.push({width,callback,destination});
  }finally{release.resolve();await context.close();}
 }
 console.log(JSON.stringify({passed:true,cases:results.length,results}));
}finally{await browser.close();}
