// Invoked by the isolated PostgreSQL suite; real API, fixture authentication, no live providers.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const target = new URL(process.env.CAPYKIT_AGENT_TEST_SERVER ?? '');
assert.equal(target.hostname, '127.0.0.1');
const principalId = process.env.CAPYKIT_AGENT_TEST_PRINCIPAL;
assert.match(principalId ?? '', /^[0-9a-f-]{36}$/u);
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ ...(process.env.CAPYKIT_CHROMIUM_PATH ? { executablePath: process.env.CAPYKIT_CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
const origin = 'https://capykit.example.test';
let missing = false, posts = 0, firstId, replacedId;
const secrets = [], failures = [];
try {
 const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
 await context.addCookies([{ name: 'capykit_session', value: 'owner', url: origin }, { name: 'capykit_csrf', value: 'safe', url: origin }]);
 const page = await context.newPage();
 page.setDefaultTimeout(6000);
 page.on('pageerror', () => failures.push('browser-error'));
 page.on('console', message => { if (/ck_agent_[A-Za-z0-9_-]{43}/u.test(message.text())) failures.push('credential-log'); });
 await context.route('**/*', async route => {
  try {
   const request = route.request(), url = new URL(request.url());
   assert.equal(url.origin, origin);
   const headers = { ...request.headers(), host: target.host };
   const response = await fetch(new URL(url.pathname + url.search, target), { method: request.method(), headers, ...(request.postData() ? { body: request.postData() } : {}), redirect: 'manual' });
   let body = Buffer.from(await response.arrayBuffer());
   if (url.pathname === '/v1/agents/keys' && request.method() === 'POST') {
    posts++;
    assert.equal(response.status, 201);
    const value = JSON.parse(body.toString('utf8'));
    assert.equal(value.principalId, principalId);
    assert.ok(typeof value.key === 'string' && /^ck_agent_[A-Za-z0-9_-]{43}$/u.test(value.key));
    secrets.push(value.key);
    if (!firstId) firstId = value.id; else replacedId = value.id;
    if (missing) { delete value.key; body = Buffer.from(JSON.stringify(value)); }
   }
   // All endpoint behavior is the real local server; only the missing-key transport defect is injected.
   const forwarded = Object.fromEntries(response.headers);
   delete forwarded['content-length']; delete forwarded['content-encoding'];
   await route.fulfill({ status: response.status, headers: forwarded, body });
  } catch { failures.push('local-api-route'); await route.abort().catch(() => {}); }
 });
 await page.goto(origin + '/?tab=agents');
 const panel = page.locator('.action-access').filter({ visible: true });
 await panel.getByLabel('Existing agent', { exact: true }).selectOption(principalId);
 await panel.locator('.agent-setup > summary').click();
 await panel.getByRole('button', { name: 'Issue key for existing agent', exact: true }).click();
 const keyField = panel.getByLabel('One-time agent key', { exact: true });
 await keyField.waitFor();
 assert.ok(await keyField.inputValue() === secrets[0]);
 assert.equal(posts, 1);
 assert.ok(await panel.getByRole('button', { name: 'Continue after saving', exact: true }).isDisabled());
 await panel.getByRole('checkbox', { name: 'I saved this key in secure secret storage.', exact: true }).check();
 await panel.getByRole('button', { name: 'Continue after saving', exact: true }).click();
 assert.equal(await keyField.count(), 0);
 assert.ok((await panel.innerText()).includes('Not yet verified'));
 missing = true;
 await panel.getByRole('button', { name: 'Replace this key', exact: true }).click();
 await panel.getByRole('button', { name: 'Confirm exact key replacement', exact: true }).click();
 await panel.getByRole('alert').first().waitFor();
 assert.equal(posts, 2); assert.notEqual(firstId, replacedId);
 assert.equal(await keyField.count(), 0);
 await panel.getByRole('button', { name: 'Reload metadata', exact: true }).click();
 await panel.getByRole('button', { name: 'Replace this key', exact: true }).waitFor();
 assert.equal(posts, 2);
 missing = false;
 await panel.getByRole('button', { name: 'Replace this key', exact: true }).click();
 const confirmation = panel.getByRole('region', { name: 'Confirm exact access change' });
 assert.ok((await confirmation.innerText()).includes(replacedId));
 await panel.getByRole('button', { name: 'Confirm exact key replacement', exact: true }).click();
 await keyField.waitFor(); assert.equal(posts, 3);
 assert.ok(await keyField.inputValue() === secrets[2]);
 await page.reload();
 await panel.getByLabel('Existing agent', { exact: true }).selectOption(principalId);
 assert.equal(await keyField.count(), 0);
 for(const width of [320,375,430,1440]){
  await page.setViewportSize({width,height:900});
  assert.equal(await panel.getByRole('heading',{level:1}).innerText(),'Browser isolated agent');
  assert.equal(await panel.locator('.agent-setup').evaluate(node=>node.open),false);
  assert.equal(await panel.locator('.agent-history').evaluate(node=>node.open),false);
  assert.ok((await panel.locator('.agent-verification').innerText()).includes('Not yet verified'));
  const nav=page.getByRole('navigation',{name:'Workspace',exact:true});
  assert.deepEqual(await nav.getByRole('button').allTextContents(),['Apps','Agents','Actions']);
  const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,nav:[...document.querySelectorAll('.workspace-nav button span')].map(node=>{const box=node.getBoundingClientRect();return box.height<=parseFloat(getComputedStyle(node).lineHeight)+1;})}));
  assert.equal(geometry.overflow,false);assert.ok(geometry.nav.every(Boolean));
  await nav.getByRole('button',{name:'Actions',exact:true}).focus();
  assert.equal(await nav.getByRole('button',{name:'Actions',exact:true}).evaluate(node=>document.activeElement===node),true);
  if(process.env.CAPYKIT_AGENT_VISUAL_DIR){
   // Metadata-only screenshots: reload discarded the reveal and no key appears in the DOM.
   const clean=await page.evaluate(values=>values.every(value=>!document.documentElement.textContent.includes(value)&&![...document.querySelectorAll('input,textarea')].some(node=>node.value.includes(value))),secrets);
   assert.ok(clean);await mkdir(process.env.CAPYKIT_AGENT_VISUAL_DIR,{recursive:true});
   await page.screenshot({path:join(process.env.CAPYKIT_AGENT_VISUAL_DIR,`real-api-agent-${width}.png`),fullPage:true});
  }
 }
 const persisted = await page.evaluate(values => [localStorage, sessionStorage].some(storage => Object.values(storage).some(value => values.some(secret => value.includes(secret)))), secrets);
 assert.equal(persisted, false);
 assert.deepEqual(failures, []);
 await context.close();
 console.log('PASS isolated real API/browser: issuance, one-time delivery, missing response, same-identity rotation, no stored plaintext');
} catch {
 console.error('FAIL isolated real API/browser (sanitized; no credentials or DOM recorded)');
 process.exitCode = 1;
} finally { await browser.close(); }
