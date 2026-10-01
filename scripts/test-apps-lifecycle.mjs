// Start the console with: npx vite src/console --host 127.0.0.1 --port 4174
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const origin=process.env.CAPYKIT_CONSOLE_URL ?? 'http://127.0.0.1:4174';
const browser=await chromium.launch({headless:true,...(process.env.CAPYKIT_CHROMIUM_PATH ? {executablePath:process.env.CAPYKIT_CHROMIUM_PATH}: {})});
const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
let driveActive=false,driveReconnect=false,githubActive=false,callbackCount=0,startCount=0,role='owner',startFails=false;
await page.route('https://accounts.google.com/**',route=>route.fulfill({contentType:'text/html',body:'<title>Google authorization fixture</title>'}));
const id='11111111-1111-4111-8111-111111111111';const repo={id:'123',fullName:'example/repository',admin:true,url:'https://github.com/example/repository'};
function github(){return {id,status:githubActive?'active':'pending',account:{id:'1',login:'Example',type:'Organization'},repositories:githubActive?[repo]:[],installationId:'1',permissions:{issues:'read',metadata:'read'},consentAt:githubActive?new Date().toISOString():null,consentByPrincipalId:'owner',updatedAt:new Date().toISOString()};}
await page.route('**/v1/**',async route=>{
 if(route.request().resourceType()==='document')return route.continue();
 const path=new URL(route.request().url()).pathname;let body={};
 if(path==='/v1/me')body={identity:{email:'owner@example.test',principalKind:'human'},workspace:{id:'workspace',role}};
 else if(path==='/v1/apps')body={apps:[{id:'github',name:'GitHub',configured:true,connected:githubActive,description:'Read issues'},{id:'google-drive',name:'Google Drive',configured:true,connected:driveActive,description:'Read metadata'}],github:[github()],google:{configured:true,connection:driveActive||driveReconnect?{status:driveActive?'active':'reconnect_required',email:'drive@example.test'}:null}};
 else if(path==='/v1/connections')body={configured:true,connections:[github()],installationUrl:'https://github.com/apps/example/installations/new',setup:null};
 else if(path==='/v1/connections/google/callback'){callbackCount++;assert.ok(route.request().postDataJSON().state);driveActive=true;body={status:'connected'};}
 else if(path==='/v1/connections/google/start'){startCount++;assert.deepEqual(route.request().postDataJSON(),{consent:true});if(startFails)return route.fulfill({status:502,json:{error:{code:'PROVIDER_UNAVAILABLE'}}});body={authorizationUrl:`https://accounts.google.com/o/oauth2/v2/auth?state=${'x'.repeat(43)}`};}
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
 await page.goto(`${origin}/?tab=connections&setup=${id}`);
 await page.getByRole('heading',{name:'Choose repositories for this workspace',exact:true}).waitFor();
 await page.getByRole('checkbox',{name:'example/repository',exact:true}).check();
 await page.getByRole('checkbox',{name:'I approve read access to these repositories for this workspace.',exact:true}).check();
 await page.getByRole('button',{name:'Confirm connection',exact:true}).click();await page.getByRole('heading',{name:'Try your connection',exact:true}).waitFor();
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Confirm disconnect',exact:true}).click();await page.getByRole('heading',{name:'Try your connection',exact:true}).waitFor({state:'hidden'});
 await page.goto(`${origin}/?tab=capabilities`);await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();
 await page.goto(`${origin}/?tab=connections&app=google-drive`);await page.getByRole('heading',{name:'Connect Google Drive',exact:true}).waitFor();
 assert.equal(await page.getByRole('checkbox').count(),0);startFails=true;
 await page.getByRole('button',{name:'Connect Google Drive',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'Connect Google Drive',exact:true}).isEnabled(),true);startFails=false;
 await page.getByRole('button',{name:'Connect Google Drive',exact:true}).click();await page.waitForURL('https://accounts.google.com/**');assert.equal(startCount,2);
 const callback=`${origin}/v1/connections/google/callback?code=one-use&state=${'x'.repeat(43)}`;
 await page.goto(callback);await page.getByRole('heading',{name:'Connected account',exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.has('code'),false);assert.equal(callbackCount,1);
 await page.getByLabel('Drive file ID').fill('file1');await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.getByText('Report',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByText(/Other workspaces and your Google account permissions will stay unchanged/).waitFor();await page.getByRole('button',{name:'Confirm disconnect',exact:true}).click();await page.getByRole('button',{name:'Connect Google Drive',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Connect Google Drive',exact:true}).isEnabled(),true);
 driveReconnect=true;await page.reload();await page.getByRole('heading',{name:'Reconnect Google Drive',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Reconnect Google Drive',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'Reconnect Google Drive',exact:true}).click();await page.waitForURL('https://accounts.google.com/**');assert.equal(startCount,3);driveReconnect=false;
 await page.goto(`${origin}/v1/connections/google/callback?error=access_denied&state=${'x'.repeat(43)}`);await page.getByText('Google Drive connection was canceled. You can connect when you’re ready.',{exact:true}).waitFor();assert.equal(callbackCount,1);assert.equal(new URL(page.url()).searchParams.get('app'),'google-drive');assert.equal(new URL(page.url()).searchParams.has('state'),false);assert.equal(await page.getByRole('button',{name:'Connect Google Drive',exact:true}).isEnabled(),true);
 await page.goto(`${origin}/v1/connections/google/callback?code=invalid&state=bad`);await page.getByText('Google Drive setup expired or could not be verified. Connect again to continue.',{exact:true}).waitFor();assert.equal(callbackCount,1);
 role='member';await page.goto(callback);await page.getByRole('heading',{name:'Functions & skills',exact:true}).waitFor();assert.equal(callbackCount,1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,githubConfirmRefresh:true,githubDisconnectRefresh:true,functionDeepLink:true,googleRedirect:true,googleStartRetry:true,googleCallback:true,googleRead:true,googleDisconnect:true,googleReconnect:true,googleCancel:true,googleExpired:true,memberCallbackDiscard:true}));
}finally{await browser.close();}
