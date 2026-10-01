import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = resolve(process.env.CAPYKIT_CONSOLE_DIR ?? 'dist/console');
const prefix = resolve(process.env.CAPYKIT_BROWSER_ARTIFACT_PREFIX ?? '/tmp/capykit-access');
const origin = 'https://capykit.example.test';
const options = { users: [{ id: 'user', name: 'Alex', email: 'alex@example.test', role: 'member' }], versions: [{ capabilityId: 'skill', name: 'Review guide', kind: 'skill', version: '1.0.0', operation: null }, { capabilityId: 'function', name: 'Read issues', kind: 'function', version: '2.0.0', operation: 'github.issues.list.v1' }], connections: [{ id: 'connection', name: 'example', repositories: [{ id: '101', name: 'example/first' }, { id: '102', name: 'example/second' }] }], truncated: false };
const capability = { id: 'skill', name: 'Review guide', slug: 'review-guide', kind: 'skill', createdAt: '2026-01-01T00:00:00Z' };
const detail = { ...capability, draft: null, versions: [{ version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', digest: 'sha256:fixture', fileCount: 1, byteCount: 100, contract: null, files: [{ path: 'SKILL.md', executable: false, byteLength: 100, sha256: 'fixture' }] }] };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
async function check(name, settings, run) {
  const context = await browser.newContext({ viewport: { width: settings.mobile ? 390 : 1440, height: 900 } });
  await context.addCookies([{ name: 'capykit_csrf', value: 'csrf-test', url: origin }]);
  const page = await context.newPage();
  const state = { grants: [], ...settings };
  const requests = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    try {
      const req = route.request(), url = new URL(req.url());
      requests.push({ path: url.pathname, method: req.method(), body: req.postData(), csrf: req.headers()['x-csrf-token'] });
      assert.equal(url.origin, origin);
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: await readFile(`${directory}/index.html`) });
      if (url.pathname.startsWith('/assets/')) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(directory + url.pathname) });
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/v1/me') return json({ identity: { email: 'alex@example.test', principalKind: 'human' }, workspace: { id: 'workspace', role: state.member ? 'member' : 'owner' } });
      if (url.pathname === '/v1/capabilities') return json({ capabilities: state.member ? [capability] : [] });
      if (url.pathname === '/v1/capabilities/skill') return json(detail);
      if (url.pathname === '/v1/connections') return json({ configured: true, setup: null, installationUrl: 'https://github.com/apps/example/installations/new', connections: [] });
      if (url.pathname === '/v1/access/options') return json(state.empty ? { ...options, versions: [] } : options);
      if (url.pathname === '/v1/grants' && req.method() === 'GET') return json({ grants: state.grants, nextCursor: null });
      if (url.pathname === '/v1/grants' && req.method() === 'POST') {
        if (state.fail) return json({ error: { code: 'CONNECTION_INACTIVE' } }, 403);
        const input = req.postDataJSON();
        state.grants.push({ id: 'grant', recipientName: 'Alex', capabilityName: input.capabilityId === 'skill' ? 'Review guide' : 'Read issues', version: input.version, repositoryIds: input.repositoryIds ?? [], action: input.capabilityId === 'skill' ? 'retrieve' : 'invoke', connectionName: input.connectionId ? 'example' : null, repositories: (input.repositoryIds ?? []).map(id => ({ id, name: `example/${id === '101' ? 'first' : 'second'}` })), expiresAt: input.expiresAt, status: 'active' });
        return json(state.grants.at(-1), 201);
      }
      if (url.pathname === '/v1/grants/grant' && req.method() === 'DELETE') { state.grants[0].status = 'revoked'; return route.fulfill({ status: 204 }); }
      throw new Error(`Unexpected ${req.method()} ${url.pathname}`);
    } catch (e) { errors.push(e.message); await route.abort(); }
  });
  try {
    await page.goto(origin + '/?tab=access');
    if (!state.member) { await page.getByRole('heading', { name: 'Existing grants' }).waitFor(); await page.waitForFunction(() => document.querySelector('section[aria-label="Workspace access"]')?.getAttribute('aria-busy') === 'false'); }
    await run({ page, state, requests });
    assert.deepEqual(errors, []); results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) { await page.screenshot({ path: `${prefix}-failure.png`, fullPage: true }); throw error; }
  finally { await context.close(); }
}
async function select(page, kind = 'function') {
  await page.getByLabel('User', { exact: true }).selectOption('user');
  await page.getByLabel('Published capability version').selectOption(`${kind}:${kind === 'function' ? '2.0.0' : '1.0.0'}`);
  if (kind === 'function') await page.getByLabel('GitHub connection', { exact: true }).selectOption('connection');
}
const submit = page => page.getByRole('button', { name: 'Grant access', exact: true });
try {
  await check('explicit repository choice and consent; changed scope clears approval', {}, async ({ page, requests }) => {
    await select(page); assert.ok(await submit(page).isDisabled());
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0);
    await page.getByRole('checkbox', { name: 'example/first', exact: true }).check();
    await page.getByRole('checkbox', { name: /^I grant/ }).check(); assert.ok(await submit(page).isEnabled());
    await page.getByRole('checkbox', { name: 'example/second', exact: true }).check(); assert.ok(await submit(page).isDisabled());
    await page.getByRole('checkbox', { name: 'example/second', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: /^I grant/ }).check();
    await page.screenshot({ path: `${prefix}-desktop.png`, fullPage: true });
    await submit(page).click(); await page.getByRole('status').filter({ hasText: 'Access granted' }).waitFor();
    const posted = requests.find(r => r.path === '/v1/grants' && r.method === 'POST');
    assert.equal(posted.csrf, 'csrf-test'); const body = JSON.parse(posted.body);
    assert.deepEqual(body.repositoryIds, ['101']); assert.equal(body.version, '2.0.0'); assert.equal(body.connectionId, 'connection'); assert.match(body.expiresAt, /Z$/);
    assert.ok(await submit(page).isDisabled());
  });
  await check('skill grant excludes provider scope and revoke requires confirmation', {}, async ({ page, requests }) => {
    await select(page, 'skill'); assert.equal(await page.getByLabel('GitHub connection', { exact: true }).count(), 0);
    await page.getByRole('checkbox', { name: /^I grant/ }).check(); await submit(page).click();
    await page.getByRole('status').filter({ hasText: 'Access granted' }).waitFor();
    const body = JSON.parse(requests.find(r => r.method === 'POST' && r.path === '/v1/grants').body);
    assert.equal(body.connectionId, undefined); assert.equal(body.repositoryIds, undefined);
    await page.getByRole('button', { name: 'Revoke access for Alex' }).click();
    await page.getByRole('button', { name: 'Keep access' }).click(); assert.equal(requests.filter(r => r.method === 'DELETE').length, 0);
    await page.getByRole('button', { name: 'Revoke access for Alex' }).click(); await page.getByRole('button', { name: 'Confirm revoke' }).click();
    await page.getByRole('status').filter({ hasText: 'Access revoked' }).waitFor(); assert.equal(requests.filter(r => r.method === 'DELETE').length, 1);
    assert.equal(await page.getByRole('button', { name: 'Revoke access for Alex' }).count(), 0);
  });
  await check('provider failure explains recovery and preserves choices', { fail: true }, async ({ page, state }) => {
    await select(page); await page.getByRole('checkbox', { name: 'example/first', exact: true }).check(); await page.getByRole('checkbox', { name: /^I grant/ }).check();
    await submit(page).click(); await page.getByRole('alert').filter({ hasText: 'Reconnect it' }).waitFor();
    assert.ok(await page.getByRole('checkbox', { name: 'example/first', exact: true }).isChecked()); state.fail = false;
    await submit(page).click(); await page.getByRole('status').filter({ hasText: 'Access granted' }).waitFor();
  });
  await check('empty library explains the prerequisite', { empty: true }, async ({ page }) => { await page.getByText('Publish a function or skill in Capabilities first.', { exact: false }).waitFor(); assert.equal(await submit(page).count(), 0); });
  await check('member gets read-only granted library without management routes', { member: true }, async ({ page, requests }) => {
    await page.getByRole('heading', { name: 'Capabilities', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Access', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: 'New capability' }).count(), 0);
    await page.getByRole('button').filter({ hasText: 'Review guide' }).click(); await page.getByRole('button', { name: 'Download 1.0.0' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Delete|Publish|Save draft/ }).count(), 0);
    assert.equal(requests.some(r => r.path === '/v1/access/options' || r.path === '/v1/connections'), false);
  });
  await check('mobile native fields fit and repository approval is keyboard accessible', { mobile: true }, async ({ page }) => {
    await select(page); const checkbox = page.getByRole('checkbox', { name: 'example/first', exact: true }); await checkbox.focus(); await page.keyboard.press('Space'); assert.ok(await checkbox.isChecked());
    const approval = page.getByRole('checkbox', { name: /^I grant/ }); await approval.focus(); await page.keyboard.press('Space'); assert.ok(await submit(page).isEnabled());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)); await page.screenshot({ path: `${prefix}-mobile.png`, fullPage: true });
  });
} finally { await writeFile(`${prefix}-results.json`, JSON.stringify(results, null, 2)); await browser.close(); }
