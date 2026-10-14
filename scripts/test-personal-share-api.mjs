// Isolated PostgreSQL suite only: actual local APIs, fixture sign-in and provider doubles.
// No keys, screenshots, traces, DOM dumps or request bodies are recorded.
import assert from 'node:assert/strict';
const target=new URL(process.env.CAPYKIT_AGENT_TEST_SERVER??'');
assert.equal(target.hostname,'127.0.0.1');
const principalId=process.env.CAPYKIT_AGENT_TEST_PRINCIPAL;
assert.match(principalId??'',/^[0-9a-f-]{36}$/u);
const {chromium}=await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({...(process.env.CAPYKIT_CHROMIUM_PATH?{executablePath:process.env.CAPYKIT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
const origin='https://capykit.example.test';
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
let stage='startup',currentScenario='';
try{
 for(const scenario of [320,375,430,1440,'lost-response','csrf','forbidden']){
  currentScenario=String(scenario);stage='open context';
  const context=await browser.newContext({viewport:{width:typeof scenario==='number'?scenario:375,height:900}});
  await context.addCookies([{name:'capykit_session',value:'owner',url:origin},{name:'capykit_csrf',value:'safe',url:origin}]);
  const page=await context.newPage();page.setDefaultTimeout(6000);
  const gate=deferred(),started=deferred(),failures=[];let posts=0,reads=0,grantPath='',fault=typeof scenario==='string'?scenario:'';
  page.on('pageerror',()=>{failures.push('browser-error');});
  await context.route('**/*',async route=>{
   try{
    const request=route.request(),url=new URL(request.url());
    // Catalog logos are cosmetic; never contact their external hosts in isolated checks.
    if(url.origin!==origin&&request.resourceType()==='image')return route.fulfill({status:204});
    assert.equal(url.origin,origin);
    const grant=/^\/v1\/connections\/personal\/[0-9a-f-]+\/grants$/u.test(url.pathname)&&request.method()==='POST';
    const headers={...request.headers(),host:target.host};let body=request.postData();
    if(url.pathname.endsWith('/sharing'))reads++;
    if(grant){
     posts++;grantPath=url.pathname;started.resolve();
     if(typeof scenario==='number')await gate.promise;
     if(fault==='csrf')headers['x-csrf-token']='fixture-wrong';
     if(fault==='forbidden')body=JSON.stringify({...request.postDataJSON(),actionName:'custom_api_call'});
    }
    const response=await fetch(new URL(url.pathname+url.search,target),{method:request.method(),headers,...(body?{body}:{}),redirect:'manual'});
    if(grant&&fault==='lost-response'){assert.equal(response.status,201);await response.arrayBuffer();return route.abort('failed');}
    const forwarded=Object.fromEntries(response.headers);delete forwarded['content-length'];delete forwarded['content-encoding'];
    await route.fulfill({status:response.status,headers:forwarded,body:Buffer.from(await response.arrayBuffer())});
   }catch{failures.push('local-api-route');await route.abort().catch(()=>{});}
  });
  try{
   stage='navigate to real local console';
   await page.goto(origin+'/?tab=connections&app=github',{waitUntil:'domcontentloaded'});
   stage='review exact personal grant';
   const personal=page.locator('.personal-app').filter({visible:true});
   await personal.getByRole('button',{name:'Share an action',exact:true}).click();
   await personal.getByLabel('User or agent',{exact:true}).selectOption(principalId);
   await personal.getByLabel('Action',{exact:true}).selectOption('getIssueInformation');
   await personal.getByRole('checkbox',{name:/^I approve this exact personal/}).check();
   await personal.getByRole('button',{name:'Share action',exact:true}).click();
   await started.promise;assert.equal(posts,1);
   stage='navigate away while grant pending';
   if(typeof scenario==='number'){
    const before=reads;
    await page.getByRole('button',{name:'← All apps',exact:true}).click();
    await page.getByRole('button',{name:/^GitHub.*Connected/s}).first().click();
    await personal.getByRole('status').filter({hasText:'Sharing request pending'}).waitFor();
    await personal.getByRole('button',{name:'Share an action',exact:true}).click();
    assert.equal(reads,before);assert.equal(await personal.getByRole('button',{name:'Share action',exact:true}).count(),0);
    gate.resolve();
    await personal.getByRole('status').filter({hasText:'Sharing request pending'}).waitFor({state:'hidden'});
    await personal.getByRole('button',{name:'Share an action',exact:true}).click();
    await personal.locator('.personal-sharing li').filter({hasText:principalId}).first().waitFor();
   }else if(fault==='lost-response'){
    await personal.getByRole('alert').filter({hasText:'Grant outcome unknown'}).first().waitFor();
    await page.getByRole('button',{name:'← All apps',exact:true}).click();
    await page.getByRole('button',{name:/^GitHub.*Connected/s}).first().click();
    await personal.getByRole('alert').filter({hasText:'Grant outcome unknown'}).waitFor();
    await personal.getByRole('button',{name:'Share an action',exact:true}).click();
    await personal.getByRole('status').filter({hasText:'The reviewed grant is recorded'}).waitFor();
   }else{
    await personal.getByRole('alert').filter({hasText:fault==='csrf'?'Reload the page to refresh your session':'You no longer have permission'}).waitFor();
    assert.doesNotMatch(await personal.innerText(),/Grant outcome unknown/);
    assert.ok(await personal.getByLabel('User or agent',{exact:true}).isEnabled());
   }
   assert.equal(posts,1);assert.ok(grantPath);
   stage='layout and route assertions';
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.deepEqual(failures,[]);
  }finally{gate.resolve();await context.close();}
 }
 console.log('PASS isolated personal API/browser: pending navigation at 320/375/430/1440px, committed lost-response reconciliation, actionable CSRF/permission denials');
}catch(error){
 console.error(`FAIL isolated personal API/browser (sanitized): scenario=${currentScenario} step=${stage} kind=${error.name}${error instanceof assert.AssertionError?' assertion='+error.message.split('\n')[0]:''}`);process.exitCode=1;
}finally{await browser.close();}
