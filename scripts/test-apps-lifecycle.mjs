// Start the console with: npx vite src/console --host 127.0.0.1 --port 4174
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const browser=await chromium.launch({headless:true,...(process.env.CAPYKIT_CHROMIUM_PATH ? {executablePath:process.env.CAPYKIT_CHROMIUM_PATH}: {})});
const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
let driveActive=false,githubActive=false,callbackCount=0,role='owner';
const id='11111111-1111-4111-8111-111111111111';const repo={id:'123',fullName:'example/repository',admin:true,url:'https://github.com/example/repository'};
function github(){return {id,status:githubActive?'active':'pending',account:{id:'1',login:'Example',type:'Organization'},repositories:githubActive?[repo]:[],installationId:'1',permissions:{issues:'read',metadata:'read'},consentAt:githubActive?new Date().toISOString():null,consentByPrincipalId:'owner',updatedAt:new Date().toISOString()};}
await page.route('**/v1/**',async route=>{
 if(route.request().resourceType()==='document')return route.continue();
 const path=new URL(route.request().url()).pathname;let body={};
 if(path==='/v1/me')body={identity:{email:'owner@example.test',principalKind:'human'},workspace:{id:'workspace',role}};
 else if(path==='/v1/apps')body={apps:[{id:'github',name:'GitHub',configured:true,connected:githubActive,description:'Read issues'},{id:'google-drive',name:'Google Drive',configured:true,connected:driveActive,description:'Read metadata'}],github:[github()],google:{configured:true,connection:driveActive?{status:'active',email:'drive@example.test'}:null}};
 else if(path==='/v1/connections')body={configured:true,connections:[github()],installationUrl:'https://github.com/apps/example/installations/new',setup:null};
 else if(path==='/v1/connections/google/callback'){callbackCount++;assert.ok(route.request().postDataJSON().state);driveActive=true;body={status:'connected'};}
 else if(path==='/v1/connections/google'){driveActive=false;}
 else if(path==='/v1/apps/google-drive/test')body={result:{id:'file1',name:'Report',mimeType:'application/pdf'}};
 else if(path===`/v1/connections/github/pending/${id}`)body={setupId:id,connectionId:id,candidates:[{installationId:'1',account:{id:'1',login:'Example',type:'Organization'},repositories:[repo]}],expiresAt:new Date(Date.now()+600000).toISOString()};
 else if(path==='/v1/connections/github/confirm'){githubActive=true;body=github();}
 else if(path===`/v1/connections/${id}`){if(route.request().method()==='DELETE')githubActive=false;body=github();}
 else if(path==='/v1/capabilities')body={capabilities:[]};
 else if(path==='/v1/grants')body={grants:[],nextCursor:null};
 else if(path==='/v1/access/options')body={principals:[],capabilities:[],connections:[]};
 await route.fulfill({json:body});
});
try{
 await page.goto(`http://127.0.0.1:4174/?tab=connections&setup=${id}`);
 await page.getByRole('heading',{name:'Choose repositories for this workspace',exact:true}).waitFor();
 await page.getByRole('checkbox',{name:'example/repository',exact:true}).check();
 await page.getByRole('checkbox',{name:'I approve read access to these repositories for this workspace.',exact:true}).check();
 await page.getByRole('button',{name:'Confirm connection',exact:true}).click();await page.getByRole('heading',{name:'Try your connection',exact:true}).waitFor();
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Confirm disconnect',exact:true}).click();await page.getByRole('heading',{name:'Try your connection',exact:true}).waitFor({state:'hidden'});
 await page.goto('http://127.0.0.1:4174/?tab=capabilities');await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();
 const callback=`http://127.0.0.1:4174/v1/connections/google/callback?code=one-use&state=${'x'.repeat(43)}`;
 await page.goto(callback);await page.getByRole('heading',{name:'Connected account',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.has('code'),false);assert.equal(callbackCount,1);
 await page.getByLabel('Drive file ID').fill('file1');await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.getByText('Report',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByText(/Other workspaces and your Google account permissions will stay unchanged/).waitFor();await page.getByRole('button',{name:'Confirm disconnect',exact:true}).click();await page.getByRole('button',{name:'Continue with Google',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Continue with Google',exact:true}).isDisabled(),true);
 role='member';await page.goto(callback);await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();assert.equal(callbackCount,1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,githubConfirmRefresh:true,githubDisconnectRefresh:true,functionDeepLink:true,googleCallback:true,googleRead:true,googleDisconnectConsent:true,memberCallbackDiscard:true}));
}finally{await browser.close();}
