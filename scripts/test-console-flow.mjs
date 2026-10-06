import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// Use an existing external Playwright installation; no product dependency is needed.
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? 'playwright');
const consoleDirectory = resolve(process.env.CAPYKIT_CONSOLE_DIR ?? 'dist/console');
const artifactPrefix = resolve(process.env.CAPYKIT_BROWSER_ARTIFACT_PREFIX ?? join(tmpdir(), 'capykit-guided'));
const origin = 'https://capykit.example.test';
const setupId = '12345678-1234-1234-1234-123456789abc';
const callbackPath = '/v1/connections/github/callback?code=CODE_SENTINEL&state=STATE_SENTINEL';
const setupPath = `/?tab=connections&setup=${setupId}`;
const repository = { id: 'repo-1', fullName: 'example/test-repository', url: 'https://github.com/example/test-repository', admin: true };
const candidate = { installationId: 'installation-1', account: { id: 'account-1', login: 'example', type: 'Organization' }, repositories: [repository] };
const pendingConnection = { id: 'existing-connection', status: 'pending', account: null, installationId: null, repositories: [], permissions: { issues: 'read', metadata: 'read' }, consentAt: null, consentByPrincipalId: null, uninstallUrl: null, createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z' };
const activeConnection = { ...pendingConnection, status: 'active', account: candidate.account, installationId: candidate.installationId, repositories: [repository], consentAt: '2026-09-29T00:00:00Z' };
const owner = { identity: { email: 'owner@example.test', principalKind: 'human' }, workspace: { id: 'workspace', role: 'owner' } };
const browser = await chromium.launch({ ...(process.env.CAPYKIT_CHROMIUM_PATH ? { executablePath: process.env.CAPYKIT_CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
const results = [];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function check(name, options, run, path = '/?tab=connections') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addCookies([{ name: 'capykit_csrf', value: 'csrf-test', url: origin }]);
  await context.addInitScript(() => {
    window.signInInputSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('input#email, input#code')) window.signInInputSeen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const state = structuredClone({ candidates: [], connections: [pendingConnection], identityStatus: 200, ...Object.fromEntries(Object.entries(options).filter(([key]) => !key.endsWith('Gate'))) });
  state.identityGate = options.identityGate;
  state.callbackGate = options.callbackGate;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    try {
      const req = route.request();
      const url = new URL(req.url());
      requests.push({ path: url.pathname, method: req.method(), body: req.postData(), headers: req.headers() });
      if (url.origin === 'https://github.com') return route.fulfill({ contentType: 'text/html', body: '<h1>GitHub authorization</h1>' });
      assert.equal(url.origin, origin);
      if (req.method() === 'GET' && (url.pathname === '/' || url.pathname.endsWith('/callback'))) return route.fulfill({ contentType: 'text/html', body: await readFile(`${consoleDirectory}/index.html`) });
      if (url.pathname.startsWith('/assets/')) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(`${consoleDirectory}${url.pathname}`) });
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/v1/me') {
        state.identityCalls = (state.identityCalls ?? 0) + 1;
        if (state.identityGate) await state.identityGate.promise;
        if (state.identityNetworkFailure) return route.abort('failed');
        return state.identityStatus === 200 ? json(owner) : json({ error: { code: state.identityStatus === 401 ? 'AUTHENTICATION_REQUIRED' : 'UNAVAILABLE' } }, state.identityStatus);
      }
      if (url.pathname === '/v1/auth/refresh') return json({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401);
      if (url.pathname === '/v1/auth/otp') return json({});
      if (url.pathname === '/v1/auth/verify') { state.identityStatus = 200; return json({}); }
      if (url.pathname === '/v1/capabilities') return json({ capabilities: [] });
      if (url.pathname === '/v1/apps') return json({ apps: [{ id:'github', name:'GitHub', configured:true, connected:state.connections.some(c=>c.status==='active'), description:'Read issues' }], github:state.connections, google:{configured:false,connection:null} });
      if (url.pathname === '/v1/connections') return json({ configured: true, setup: null, installationUrl: 'https://github.com/apps/capykit-test/installations/new', connections: state.connections });
      if (url.pathname === '/v1/connections/github/callback' || url.pathname === `/v1/connections/github/pending/${setupId}`) {
        if (req.method() === 'DELETE') return json({ error: { code: 'NOT_FOUND' } }, state.cancelStatus ?? 404);
        if (state.callbackGate) await state.callbackGate.promise;
        if (state.callbackError) return json({ error: { code: state.callbackError } }, 422);
        return json({ setupId, connectionId: pendingConnection.id, candidates: state.candidates, expiresAt: '2030-01-01T00:00:00Z' });
      }
      if (url.pathname.startsWith('/v1/connections/') && !url.pathname.includes('/github/')) {
        const connection = state.connections.find(connection => url.pathname.endsWith(connection.id));
        assert.ok(connection);
        if (req.method() === 'DELETE') {
          connection.status = 'revoked';
          return route.fulfill({ status: 204 });
        }
        return json(connection);
      }
      if (url.pathname === '/v1/connections/github/start') return json({ authorizationUrl: 'https://github.com/login/oauth/authorize?state=test-state' });
      if (url.pathname === '/v1/connections/github/confirm') {
        if (state.confirmError) return json({ error: { code: state.confirmError } }, 410);
        state.connections = [activeConnection]; return json(activeConnection);
      }
      throw new Error(`Unexpected ${req.method()} ${url.pathname}`);
    } catch (error) {
      errors.push(error.message);
      await route.abort().catch(() => {});
    }
  });
  try {
    await page.goto(`${origin}${path}`);
    if (!state.manualWait) await connectionsReady(page);
    await run({ page, requests, state });
    assert.deepEqual(errors, []);
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    await page.screenshot({ path: `${artifactPrefix}-failure.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally { state.identityGate?.resolve(); state.callbackGate?.resolve(); await context.close(); }
}

async function connectionsReady(page) {
  await page.waitForFunction(() => document.querySelector('section.connections')?.getAttribute('aria-busy') === 'false');
  if (await page.getByRole('heading',{name:'Apps',exact:true}).isVisible()) await page.locator('.app-row').filter({hasText:'GitHub'}).click();
}

async function noSignIn(page) {
  assert.equal(await page.locator('input#email, input#code').count(), 0);
  assert.equal(await page.evaluate(() => window.signInInputSeen), false);
}

async function assertReused(page, requests, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('heading', { name: 'GitHub authorization', exact: true }).waitFor();
  const starts = requests.filter(req => req.path === '/v1/connections/github/start');
  assert.equal(starts.length, 1);
  assert.deepEqual(JSON.parse(starts[0].body), { connectionId: pendingConnection.id });
  assert.equal(starts[0].headers['x-csrf-token'], 'csrf-test');
}

async function recoverDetails(page) {
  const summary = page.locator('summary').filter({ hasText: 'Missing a repository?' });
  await summary.click();
  return summary;
}

try {
  for (const path of ['/?tab=connections', callbackPath]) await check(`delayed identity check never renders sign-in (${path.includes('callback') ? 'OAuth return' : 'initial visit'})`, { manualWait: true, identityGate: deferred(), candidates: [candidate] }, async ({ page, state, requests }) => {
    await page.getByRole('status').first().waitFor();
    await noSignIn(page);
    assert.equal(requests.filter(request => request.path.includes('/github/callback') && request.method === 'POST').length, 0);
    if (path.includes('callback')) assert.doesNotMatch(page.url(), /CODE_SENTINEL|STATE_SENTINEL|callback/);
    await page.screenshot({ path: `${artifactPrefix}-${path.includes('callback') ? 'return' : 'session'}-loading.png`, fullPage: false });
    state.identityGate.resolve(); state.identityGate = null;
    await connectionsReady(page);
    await noSignIn(page);
  }, path);

  for (const failure of ['unavailable', 'network']) await check(`initial session ${failure} offers retry without sign-in`, { manualWait: true, identityStatus: failure === 'unavailable' ? 503 : 200, identityNetworkFailure: failure === 'network' }, async ({ page, state }) => {
    await page.getByRole('button', { name: 'Retry session check' }).waitFor();
    await noSignIn(page);
    state.identityStatus = 200; state.identityNetworkFailure = false;
    await page.getByRole('button', { name: 'Retry session check' }).click();
    await connectionsReady(page);
    await noSignIn(page);
  });

  await check('unauthenticated callback displays sign-in and cannot replay discarded provider credentials', { manualWait: true, identityStatus: 401 }, async ({ page, requests }) => {
    await page.getByLabel('Invited email address').waitFor();
    assert.doesNotMatch(page.url(), /CODE_SENTINEL|STATE_SENTINEL|callback/);
    assert.equal(requests.filter(request => request.path === '/v1/connections/github/callback' && request.method === 'POST').length, 0);
    await page.getByLabel('Invited email address').fill('owner@example.test');
    await page.getByRole('button', { name: 'Send sign-in code' }).click();
    await page.getByLabel('Six-digit sign-in code').fill('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await connectionsReady(page);
    assert.equal(requests.filter(request => request.path === '/v1/connections/github/callback' && request.method === 'POST').length, 0);
  }, callbackPath);

  await check('focus session check preserves repository choices, consent, and mounted connection', { candidates: [candidate] }, async ({ page, state, requests }) => {
    await page.getByRole('checkbox', { name: repository.fullName, exact: true }).check();
    await page.getByRole('checkbox', { name: /^I approve/ }).check();
    const beforeCallbacks = requests.filter(request => request.path === '/v1/connections/github/callback' && request.method === 'POST').length;
    const oldCalls = state.identityCalls;
    state.identityGate = deferred();
    await page.evaluate(() => { window.connectionNodeBefore = document.querySelector('section.connections'); window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'true');
    await noSignIn(page);
    assert.equal(await page.getByRole('checkbox', { name: repository.fullName, exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: /^I approve/ }).isChecked(), true);
    state.identityGate.resolve(); state.identityGate = null;
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    assert.ok(state.identityCalls > oldCalls);
    assert.equal(await page.evaluate(() => window.connectionNodeBefore === document.querySelector('section.connections')), true);
    assert.equal(requests.filter(request => request.path === '/v1/connections/github/callback' && request.method === 'POST').length, beforeCallbacks);
  }, callbackPath);

  await check('transient identity failure preserves OAuth return for a successful retry', { manualWait: true, identityStatus: 503, candidates: [candidate] }, async ({ page, state, requests }) => {
    await page.getByRole('button', { name: 'Retry session check' }).waitFor();
    await noSignIn(page);
    assert.doesNotMatch(page.url(), /CODE_SENTINEL|STATE_SENTINEL|callback/);
    assert.equal(requests.filter(request => request.path === '/v1/connections/github/callback' && request.method === 'POST').length, 0);
    state.identityStatus = 200;
    await page.getByRole('button', { name: 'Retry session check' }).click();
    await connectionsReady(page);
    await noSignIn(page);
    const returns = requests.filter(request => request.path === '/v1/connections/github/callback' && request.method === 'POST');
    assert.equal(returns.length, 1);
    assert.deepEqual(JSON.parse(returns[0].body), { code: 'CODE_SENTINEL', state: 'STATE_SENTINEL' });
    await page.getByRole('heading', { name: 'Choose repositories for this workspace' }).waitFor();
  }, callbackPath);

  await check('session retry displays sign-in only after definitive 401', { manualWait: true, identityStatus: 503 }, async ({ page, state }) => {
    await page.getByRole('button', { name: 'Retry session check' }).waitFor();
    await noSignIn(page);
    state.identityStatus = 401;
    await page.getByRole('button', { name: 'Retry session check' }).click();
    await page.getByLabel('Invited email address').waitFor();
  });

  await check('new connection has one guided primary action and no false completion', { connections: [] }, async ({ page, requests }) => {
    await page.getByRole('heading', { name: 'Connect GitHub', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /Check GitHub access|Authorize GitHub/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Confirm connection' }).count(), 0);
    assert.equal(await page.getByRole('checkbox').count(), 0);
    await page.screenshot({ path: `${artifactPrefix}-intro.png`, fullPage: true });
    await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
    await page.getByRole('heading', { name: 'GitHub authorization' }).waitFor();
    const starts = requests.filter(request => request.path === '/v1/connections/github/start');
    assert.equal(starts.length, 1);
    assert.deepEqual(JSON.parse(starts[0].body), {});
  });

  await check('empty discovery has recovery actions instead of unusable selection and approval controls', {}, async ({ page, requests }) => {
    await page.getByRole('heading', { name: 'No repositories are ready to connect' }).waitFor();
    assert.equal(await page.getByRole('combobox').count(), 0);
    assert.equal(await page.getByRole('checkbox').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Confirm connection' }).count(), 0);
    await page.getByRole('link', { name: 'Manage GitHub access' }).waitFor();
    await page.screenshot({ path: `${artifactPrefix}-empty.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${artifactPrefix}-empty-mobile.png`, fullPage: true });
    await assertReused(page, requests, 'Continue with GitHub');
  }, setupPath);

  await check('all-repositories rejection explains precise recovery and reuses failed setup', { callbackError: 'GITHUB_SELECTED_REPOSITORIES_REQUIRED', connections: [{ ...pendingConnection, status: 'reconnect_required' }] }, async ({ page, requests }) => {
    await page.getByRole('alert').filter({ hasText: 'All repositories' }).waitFor();
    await page.getByRole('heading', { name: 'Choose repositories on GitHub' }).waitFor();
    assert.doesNotMatch(page.url(), /CODE_SENTINEL|STATE_SENTINEL|callback/);
    assert.equal(await page.getByText('Reconnect required', { exact: true }).count(), 0);
    await page.screenshot({ path: `${artifactPrefix}-error.png`, fullPage: true });
    await assertReused(page, requests, 'Continue with GitHub');
  }, callbackPath);

  await check('unfinished connection uses the original ID without active-connection warning', {}, async ({ page, requests }) => {
    await page.getByRole('navigation', { name: 'Connections', exact: true }).getByRole('button').first().click();
    await page.getByRole('heading', { name: 'Finish setup', exact: true }).waitFor();
    assert.equal(await page.getByText('Starting a reconnect pauses use', { exact: false }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).count(), 1);
    await assertReused(page, requests, 'Continue with GitHub');
  });

  await check('single account review requires repository choice followed by explicit workspace consent', { candidates: [candidate] }, async ({ page, requests }) => {
    const heading = page.getByRole('heading', { name: 'Choose repositories for this workspace' });
    await heading.waitFor();
    assert.equal(await heading.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.getByRole('combobox').count(), 0);
    const repo = page.getByRole('checkbox', { name: repository.fullName, exact: true });
    const consent = page.getByRole('checkbox', { name: /^I approve/ });
    const confirm = page.getByRole('button', { name: 'Confirm connection', exact: true });
    assert.equal(await repo.isChecked(), false);
    assert.equal(await consent.count(), 0);
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Check again' }).isVisible(), false);
    await page.screenshot({ path: `${artifactPrefix}-review.png`, fullPage: true });
    await repo.check();
    assert.equal(await consent.isChecked(), false);
    assert.equal(await consent.isEnabled(), true);
    assert.equal(await confirm.isDisabled(), true);
    await consent.check();
    assert.equal(await confirm.isEnabled(), true);
    await repo.uncheck();
    assert.equal(await consent.count(), 0);
    assert.equal(await confirm.isDisabled(), true);
    await repo.check();
    assert.equal(await consent.isChecked(), false);
    await consent.check();
    await page.screenshot({ path: `${artifactPrefix}-approve.png`, fullPage: true });
    await confirm.click();
    await page.getByRole('status').filter({ hasText: 'GitHub is connected' }).waitFor();
    const confirms = requests.filter(request => request.path === '/v1/connections/github/confirm');
    assert.equal(confirms.length, 1);
    assert.deepEqual(JSON.parse(confirms[0].body), { setupId, installationId: candidate.installationId, repositoryIds: [repository.id], consent: true });
    assert.equal(confirms[0].headers['x-csrf-token'], 'csrf-test');
    assert.doesNotMatch(page.url(), /setup=|CODE_SENTINEL|STATE_SENTINEL/);
    await page.screenshot({ path: `${artifactPrefix}-success.png`, fullPage: true });
  }, callbackPath);

  await check('native keyboard selection, consent, and recovery details work on mobile', { candidates: [candidate] }, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const heading = page.getByRole('heading', { name: 'Choose repositories for this workspace' });
    const repo = page.getByRole('checkbox', { name: repository.fullName, exact: true });
    await heading.focus();
    await page.keyboard.press('Tab');
    assert.equal(await repo.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Space');
    assert.equal(await repo.isChecked(), true);
    const consent = page.getByRole('checkbox', { name: /^I approve/ });
    await page.keyboard.press('Tab');
    assert.equal(await consent.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Space');
    assert.equal(await consent.isChecked(), true);
    const summary = page.locator('summary').filter({ hasText: 'Missing a repository?' });
    await summary.focus();
    await page.keyboard.press('Space');
    assert.equal(await summary.evaluate(element => element.parentElement.open), true);
    await page.getByRole('button', { name: 'Check again' }).waitFor();
    assert.equal(await repo.isChecked(), true);
    assert.equal(await consent.isChecked(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${artifactPrefix}-review-mobile.png`, fullPage: true });
  }, setupPath);

  await check('multiple accounts require choice and switching account clears approval', { candidates: [candidate, { ...candidate, installationId: 'installation-2', account: { ...candidate.account, login: 'another-account' } }] }, async ({ page }) => {
    const accounts = page.getByRole('combobox', { name: 'Choose a GitHub account' });
    assert.equal(await accounts.inputValue(), '');
    assert.equal(await page.getByRole('checkbox', { name: /^I approve/ }).count(), 0);
    await accounts.selectOption(candidate.installationId);
    await page.getByRole('checkbox', { name: repository.fullName, exact: true }).check();
    await page.getByRole('checkbox', { name: /^I approve/ }).check();
    await accounts.selectOption('installation-2');
    assert.equal(await page.getByRole('checkbox', { name: repository.fullName, exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('checkbox', { name: /^I approve/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Confirm connection' }).isDisabled(), true);
  }, setupPath);

  await check('active reconnect explicitly warns before pausing an approved connection', { connections: [activeConnection] }, async ({ page, requests }) => {
    await page.getByRole('navigation', { name: 'Connections', exact: true }).getByRole('button').first().click();
    await page.getByRole('button', { name: 'Review and reconnect', exact: true }).click();
    await page.getByText('Starting a reconnect pauses use', { exact: false }).waitFor();
    assert.equal(requests.filter(request => request.path === '/v1/connections/github/start').length, 0);
    await assertReused(page, requests, 'Continue with GitHub');
  });

  await check('multiple unfinished rows require explicit choice without creating a duplicate', { connections: [pendingConnection, { ...pendingConnection, id: 'other-unfinished' }] }, async ({ page, requests }) => {
    await page.getByText('Choose an unfinished setup under Your connections', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).count(), 0);
    await page.getByRole('navigation', { name: 'Connections', exact: true }).getByRole('button').first().click();
    await assertReused(page, requests, 'Continue with GitHub');
  });

  await check('expired review replaces stale confirmation with same-connection recovery', { candidates: [candidate], confirmError: 'CONNECT_SETUP_EXPIRED' }, async ({ page, requests }) => {
    await page.getByRole('checkbox', { name: repository.fullName, exact: true }).check();
    await page.getByRole('checkbox', { name: /^I approve/ }).check();
    await page.getByRole('button', { name: 'Confirm connection' }).click();
    await page.getByRole('heading', { name: 'Review expired' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Confirm connection' }).count(), 0);
    await assertReused(page, requests, 'Continue with GitHub');
  }, setupPath);

  for (const cancelStatus of [404, 410]) await check(`cancel clears an already-gone setup (${cancelStatus})`, { candidates: [candidate], cancelStatus }, async ({ page }) => {
    await page.getByRole('button', { name: 'Cancel setup' }).click();
    await page.getByRole('status').filter({ hasText: 'Setup canceled.' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Choose repositories for this workspace' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).isEnabled(), true);
    assert.doesNotMatch(page.url(), /setup=/);
  }, setupPath);

  await check('hidden Connections callback completion never steals focus from Capabilities', { candidates: [candidate], manualWait: true, callbackGate: deferred() }, async ({ page, state }) => {
    await page.getByRole('button', { name: 'Functions', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Functions', exact: true }).click();
    state.callbackGate.resolve(); state.callbackGate = null;
    await connectionsReady(page);
    assert.equal(await page.getByRole('button', { name: 'Functions', exact: true }).evaluate(element => element === document.activeElement), true);
    assert.equal(await page.getByRole('heading', { name: 'Choose repositories for this workspace' }).count(), 0);
    await page.getByRole('button', { name: 'Apps', exact: true }).click();
    await page.getByRole('heading', { name: 'Choose repositories for this workspace' }).waitFor();
  }, callbackPath);

  await check('delayed provider callback keeps progress visible until review is ready', { candidates: [candidate], manualWait: true, callbackGate: deferred() }, async ({ page, state, requests }) => {
    await page.getByRole('heading', { name: 'Checking your GitHub access…', exact: true }).waitFor();
    await noSignIn(page);
    assert.doesNotMatch(page.url(), /CODE_SENTINEL|STATE_SENTINEL|callback/);
    assert.equal(requests.filter(request => request.path === '/v1/connections/github/confirm').length, 0);
    await page.screenshot({ path: `${artifactPrefix}-provider-loading.png`, fullPage: false });
    state.callbackGate.resolve(); state.callbackGate = null;
    await connectionsReady(page);
    const heading = page.getByRole('heading', { name: 'Choose repositories for this workspace' });
    assert.equal(await heading.evaluate(element => element === document.activeElement), true);
    await page.getByRole('list', { name: 'Connection progress' }).locator('[aria-current="step"]').filter({ hasText: 'Approve workspace access' }).waitFor();
  }, callbackPath);

  await check('unfinished connection offers back navigation and confirmed discard without granting access', {}, async ({ page, requests }) => {
    const connection = page.getByRole('navigation', { name: 'Connections', exact: true }).getByRole('button').first();
    await connection.click();
    await page.getByRole('button', { name: 'Back to connections' }).click();
    await page.getByRole('heading', { name: 'Finish connecting GitHub' }).waitFor();
    await connection.click();
    await page.locator('summary').filter({ hasText: 'Cancel this setup' }).click();
    await page.getByRole('button', { name: 'Discard setup', exact: true }).click();
    assert.equal(requests.filter(request => request.method === 'DELETE').length, 0);
    await page.getByRole('button', { name: 'Confirm discard', exact: true }).click();
    await page.getByText('Disconnected', { exact: true }).first().waitFor();
    assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.path), [`/v1/connections/${pendingConnection.id}`]);
    assert.equal(requests.filter(request => request.path === '/v1/connections/github/confirm').length, 0);
  });

  console.log(`${results.length} mocked browser guided-flow checks passed`);
} finally {
  await writeFile(`${artifactPrefix}-browser-results.json`, JSON.stringify({ timestamp: new Date().toISOString(), checks: results, passed: results.filter(result => result.passed).length }, null, 2));
  await browser.close();
}
