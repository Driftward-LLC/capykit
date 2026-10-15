// ENG-154 browser fixtures ONLY: every request is intercepted, never a deployed/API/provider check.
// Run after integration: node scripts/test-agent-setup.mjs
// CAPYKIT_AGENT_SOURCE=1 bundles current source in memory instead of reading dist/console.
// Existing scripts' CAPYKIT_PLAYWRIGHT_MODULE / CAPYKIT_CHROMIUM_PATH overrides are supported.
// Labels are centralized below; selectors use roles, actual UUID option values and native forms.
// No traces, HAR, DOM dumps, credentials, or raw request bodies are written/logged.
// Optional CAPYKIT_AGENT_VISUAL_DIR captures only explicitly credential-free metadata scenarios.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://capykit.example.test';
const fixedNow = new Date('2026-10-15T18:30:00.000Z');
const csrf = `fixture-${randomUUID()}`;
const labels = {
  existing: /^(Use an existing agent|Existing agent|Choose existing agent|Reuse an agent)$/i,
  newAgent: /^(Create a new agent|New agent|Create new identity)$/i,
  agent: /^(Agent|Agent identity|Existing agent|Choose agent|Select agent)$/i,
  name: /^Agent name$/i,
  issue: /^(Create agent and key|Create agent key|Issue(?: a| new| another)? key(?: for existing agent)?|Create(?: a| new| another)? key|Generate(?: a| new)? key|Add(?: a| new)? key)$/i,
  saved: /^(Continue after saving|I saved(?: the| my)? key|I(?: have|'ve) saved(?: the| my)? key(?: securely)?|Key saved)$/i,
  copy: /^Copy(?: agent)? key$/i,
  next: /^(Next|Continue|Next: .+|Continue to .+|Choose an action|Grant an action|Connect client)$/i,
  back: /^(Back|Previous|Back to .+|← Back)$/i,
  consent: /^(I (grant|approve|authorize|understand)|Allow this|Confirm this access)/i,
  grant: /^(Grant action access|Grant access|Confirm grant|Grant selected action)$/i,
  refresh: /^(Reload metadata|Refresh(?: action access| agents| access)?|Reconcile(?: access| keys)?|Check existing keys)$/i,
  test: /^(Test connection|Run owner test|Test as owner|Try in Apps|Open Apps|Open app|Test read-only action)$/i,
};
const results = [];
const screenshots = [];
const visualOnly = process.env.CAPYKIT_AGENT_VISUAL_ONLY === '1';
const baseline = process.env.CAPYKIT_AGENT_BASELINE === '1';
let evidenceMetadata;
let step = 'startup', browser;

async function exists(path) { return access(path).then(() => true, () => false); }
async function loadPlaywright() {
  if (process.env.CAPYKIT_PLAYWRIGHT_MODULE) return import(process.env.CAPYKIT_PLAYWRIGHT_MODULE);
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  }
  // Reuse already-installed external tools; no installs or project dependency changes.
  for (const cache of [join(process.env.HOME ?? '/opt/data', '.npm/_npx'), '/opt/data/home/.npm/_npx']) {
    for (const entry of (await readdir(cache).catch(() => [])).sort()) {
      for (const name of ['playwright', 'playwright-core']) {
        const module = join(cache, entry, 'node_modules', name, 'index.mjs');
        if (await exists(module)) return import(pathToFileURL(module).href);
      }
    }
  }
  throw new Error('Set CAPYKIT_PLAYWRIGHT_MODULE to an installed Playwright index.mjs.');
}
async function chromiumPath() {
  if (process.env.CAPYKIT_CHROMIUM_PATH) return process.env.CAPYKIT_CHROMIUM_PATH;
  for (const cache of ['/opt/data/browser-fixtures', '/opt/hermes/tools']) {
    for (const entry of (await readdir(cache).catch(() => [])).sort().reverse()) {
      for (const suffix of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux64/chrome']) {
        const path = join(cache, entry, suffix);
        if (await exists(path)) return path;
      }
    }
  }
  return undefined;
}
async function assets() {
  if (process.env.CAPYKIT_AGENT_SOURCE === '1') {
    const { build } = await import('esbuild');
    const built = await build({ entryPoints: [join(root, 'src/console/main.ts')], bundle: true, write: false,
      loader: { '.woff2': 'file' }, outdir: 'fixture', format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const html = await readFile(join(root, 'src/console/index.html'), 'utf8');
    const files = new Map(built.outputFiles.map(file => [`/assets/${file.path.split('/').at(-1)}`, Buffer.from(file.contents)]));
    files.set('/assets/theme-bootstrap.js', await readFile(join(root, 'src/console/public/assets/theme-bootstrap.js')));
    files.set('/', html.replace(/<script\b[^>]*type="module"[^>]*src=["'][^"']+["'][^>]*><\/script>/u,
      '<link rel="stylesheet" href="/assets/main.css"><script type="module" src="/assets/main.js"></script>'));
    return async path => files.get(path);
  }
  const directory = resolve(process.env.CAPYKIT_CONSOLE_DIR ?? join(root, 'dist/console'));
  await access(join(directory, 'index.html'));
  return path => readFile(path === '/' ? join(directory, 'index.html') : join(directory, path));
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function completed(promise) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture mutation was not observed.')), 4500); })]); }
  finally { clearTimeout(timer); }
}
function fixture(settings) {
  const id = Object.fromEntries(['workspace', 'a', 'b', 'noKey', 'owner', 'a1', 'a2', 'b1', 'ga', 'gb', 'connection', 'otherConnection', 'personal', 'otherPersonal'].map(name => [name, randomUUID()]));
  const expiresAt = new Date(fixedNow.getTime() + 30 * 86400000).toISOString();
  const repositories = [{ id: '101', name: 'fixture/first' }, { id: '102', name: 'fixture/second' }];
  const actions = [{ id: 'github.get-issue.v1', app: 'github', name: 'Get an issue', description: 'Read-only issue metadata.', fields: [{ key: 'issueNumber', name: 'Issue number', description: '', required: true, type: 'number' }], connections: [{ id: id.connection, name: 'Fixture GitHub', repositories }, { id: id.otherConnection, name: 'Other fixture GitHub', repositories: [{ id: '103', name: 'fixture/third' }] }] },
    { id: 'drive.get-file.v1', app: 'google-drive', name: 'Get file metadata', description: 'Read-only file metadata.', fields: [{ key: 'fileId', name: 'File link or ID', description: '', required: true, type: 'text' }], connections: [{ id: id.workspace, name: 'fixture@example.test', repositories: [] }] }];
  const recipients = [{ id: id.a, name: 'Same agent name', kind: 'agent' }, { id: id.b, name: 'Same agent name', kind: 'agent' }, { id: id.noKey, name: 'Agent without a key', kind: 'agent' }, { id: id.owner, name: 'Fixture owner', kind: 'human' }];
  const keys = [{ id: id.a1, principalId: id.a, name: recipients[0].name, expiresAt, status: 'active' }, { id: id.a2, principalId: id.a, name: recipients[0].name, expiresAt, status: 'active' }, { id: id.b1, principalId: id.b, name: recipients[1].name, expiresAt, status: 'active' }];
  if (settings.noActiveFor) for (const key of keys) if (key.principalId === id[settings.noActiveFor]) key.status = 'revoked';
  const grants = [{ id: id.ga, recipientId: id.a, name: recipients[0].name, actionId: actions[0].id, connectionId: id.connection, repositoryIds: ['101'], expiresAt, status: 'active' }, { id: id.gb, recipientId: id.b, name: recipients[1].name, actionId: actions[0].id, connectionId: id.connection, repositoryIds: ['102'], expiresAt, status: 'active' }];
  return { id, recipients, keys, grants, actions, expiresAt, requests: [], violations: [], sentinels: [],
    keyStarted: deferred(), grantStarted: deferred(), connectionStarted: deferred(), keyGate: null, grantGate: null, connectionGate: null, keyResponse: 'ok', grantResponse: 'ok', personalGrants: [], failRefresh: false, clipboardFails: false, ownerReads: 0, ...settings };
}
const visible = locator => locator.filter({ visible: true });
const button = (scope, name) => visible(scope.getByRole('button', { name }));
const mutations = (state, path) => state.requests.filter(request => request.method === 'POST' && request.path === path);
const keyPosts = state => mutations(state, '/v1/agents/keys');
const grantPosts = state => mutations(state, '/v1/action-grants');
function verifyWrites(state) {
  for (const request of state.requests.filter(request => !['GET', 'HEAD'].includes(request.method))) {
    assert.equal(request.csrf, csrf, 'Every fixture mutation must use the session CSRF token.');
    assert.equal(request.authorization, false, 'The browser must not send an agent credential.');
  }
  assert.deepEqual(state.violations, [], 'Unexpected network or runtime behavior (metadata only).');
}
async function check(name, settings, run) {
  step = 'open fixture';
  const state = fixture(settings);
  const context = await browser.newContext({ viewport: { width: settings.width ?? 1440, height: 900 },
    timezoneId: settings.timezone ?? 'America/Los_Angeles', hasTouch: (settings.width ?? 1440) < 600,
    colorScheme: settings.media ?? 'light', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
  if(settings.theme) await context.addInitScript(theme=>{localStorage.setItem('capykit.appearance',theme);},settings.theme);
  await context.addCookies([{ name: 'capykit_csrf', value: csrf, url: origin }]);
  await context.addInitScript(() => {
    window.__fixtureClipboard = { fail: false, calls: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { window.__fixtureClipboard.calls++; if (window.__fixtureClipboard.fail) throw new DOMException('Fixture clipboard denied', 'NotAllowedError'); },
    } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(4500);
  page.on('pageerror', () => state.violations.push('pageerror'));
  page.on('console', message => { if (/ck_agent_[A-Za-z0-9_-]{43}/u.test(message.text())) state.violations.push('credential-in-console'); });
  await page.clock.setFixedTime(fixedNow);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    try {
      assert.equal(url.origin, origin, 'External traffic is forbidden.');
      const body = request.postData() ? request.postDataJSON() : undefined;
      if (JSON.stringify(body)?.match(/ck_agent_[A-Za-z0-9_-]{43}/u)) throw new Error('credential-in-request');
      const metadata = { path, method: request.method(), csrf: request.headers()['x-csrf-token'], authorization: Boolean(request.headers().authorization), body };
      state.requests.push(metadata);
      if (path === '/' || path.startsWith('/assets/')) {
        const content = await getAsset(path);
        assert.ok(content, 'Fixture asset missing.');
        return route.fulfill({ contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/javascript', body: content });
      }
      if (state.connectionError && ((request.method() === 'DELETE' && path.startsWith('/v1/connections/')) || path === '/v1/connections/github/start')) {
        state.connectionStarted.resolve();
        if (state.connectionGate) await state.connectionGate.promise;
        return json({ error: { code: state.connectionError } }, 403);
      }
      if (path === '/v1/auth/method') return json({ method: 'email', available: true });
      if (path === '/v1/me') return json({ identity: { email: 'owner@example.test', principalKind: 'human' }, workspace: { id: state.id.workspace, role: 'owner' } });
      if (path === '/v1/capabilities') return json({ capabilities: [] });
      if (path === '/v1/access/options') return json({ users: [], versions: [], connections: [], truncated: false });
      if (path === '/v1/grants' && request.method() === 'GET') return json({ grants: [], nextCursor: null });
      if (path === '/v1/actions') return json({ actions: state.actions });
      if (path === '/v1/action-access') {
        if(state.accessGate) await state.accessGate.promise;
        if (state.failRefresh) return json({ error: { code: 'FIXTURE_UNAVAILABLE' } }, 503);
        if(state.emptyAgents) return json({ recipients: [], keys: [], grants: [], actions: [] });
        return json({ recipients: state.recipients, keys: state.keys, grants: state.grants, actions: state.actions });
      }
      if (path === '/v1/agents/keys' && request.method() === 'POST') {
        assert.equal(['name', 'principalId', 'rotateKeyId'].filter(field => Object.hasOwn(body, field)).length, 1, 'Key selectors must be mutually exclusive.');
        assert.ok(Date.parse(body.expiresAt) > fixedNow.getTime(), 'Key expiry must be in the future.');
        if(state.keyResponse==='denied'){
          state.keyStarted.resolve();
          if(state.keyGate)await state.keyGate.promise;
          return json({error:{code:'FORBIDDEN'}},403);
        }
        let principalId = body.principalId;
        if (body.rotateKeyId) {
          const old = state.keys.find(key => key.id === body.rotateKeyId);
          assert.ok(old && old.status === 'active', 'Rotation must target a current, exact key ID.');
          principalId = old.principalId; old.status = 'revoked';
        } else if (body.name) {
          principalId = randomUUID(); state.recipients.push({ id: principalId, name: body.name, kind: 'agent' });
        }
        assert.ok(state.recipients.some(recipient => recipient.id === principalId && recipient.kind === 'agent'));
        const id = randomUUID(), key = `ck_agent_${randomBytes(32).toString('base64url')}`;
        state.sentinels.push(key);
        state.keys.unshift({ id, principalId, name: state.recipients.find(recipient => recipient.id === principalId).name, expiresAt: body.expiresAt, status: 'active' });
        state.keyStarted.resolve();
        if (state.keyGate) await state.keyGate.promise;
        if (state.keyResponse === 'ambiguous') return route.abort('failed'); // Metadata committed, response lost.
        if (state.keyResponse === 'timeout') return json({ error: { code: 'REQUEST_TIMEOUT' } }, 408);
        if (state.keyResponse === 'missing') return json({ id, principalId, expiresAt: body.expiresAt }, 201);
        return json({ id, principalId, expiresAt: body.expiresAt, key }, 201);
      }
      if (path === '/v1/action-grants' && request.method() === 'POST') {
        assert.ok(state.recipients.some(recipient => recipient.id === body.recipientId));
        const action = state.actions.find(action => action.id === body.actionId);
        assert.ok(action && action.connections.some(connection => connection.id === body.connectionId));
        assert.ok(action.app === 'github' ? body.repositoryIds.length > 0 : body.repositoryIds.length === 0);
        const id = randomUUID();
        state.grants.unshift({ id, name: state.recipients.find(recipient => recipient.id === body.recipientId).name, ...body, status: 'active' });
        state.grantStarted.resolve();
        if (state.grantGate) await state.grantGate.promise;
        if (state.grantResponse === 'ambiguous') return route.abort('failed');
        return json({ id }, 201);
      }
      if (/^\/v1\/(agents\/keys|action-grants)\//u.test(path) && request.method() === 'DELETE') {
        const items = path.includes('/agents/keys/') ? state.keys : state.grants;
        const item = items.find(item => item.id === path.split('/').at(-1));
        assert.ok(item); item.status = 'revoked'; return route.fulfill({ status: 204 });
      }
      const connection = { id: state.id.connection, status: 'active', account: { login: 'Fixture GitHub', id: '1', type: 'Organization' }, installationId: '1', repositories: [{ id: '101', fullName: 'fixture/first', url: 'https://github.com/fixture/first' }, { id: '102', fullName: 'fixture/second', url: 'https://github.com/fixture/second' }], permissions: { issues: 'read', metadata: 'read' }, consentAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(), createdAt: fixedNow.toISOString() };
      if (path === '/v1/apps') {
        if(state.appsGate) await state.appsGate.promise;
        if(state.appsError) return json({error:{code:'UNAVAILABLE'}},503);
        return json({ apps: state.emptyApps?[]:[{ id: 'github', name: 'GitHub', configured: true, connected: true, supportedInCapykit: true, categories: [], actionCount: 1, triggerCount: 0, description: 'Read-only issue metadata.' }, { id: 'google-drive', name: 'Google Drive', configured: !state.unconfiguredDrive, connected: !state.reconnectDrive&&!state.unconfiguredDrive, supportedInCapykit: true, categories: [], actionCount: 1, triggerCount: 0, description: 'Read-only file metadata.' }], github: [connection], google: { configured: !state.unconfiguredDrive, connection: state.unconfiguredDrive?null:{ status: state.reconnectDrive?'reconnect_required':'active', email: 'fixture@example.test' } }, personalEnabled: state.personal === true });
      }
      if (path === '/v1/connections') return json({ configured: true, setup: null, connections: [connection], installationUrl: 'https://github.com/apps/fixture/installations/new' });
      if(path===`/v1/connections/${state.id.connection}`&&request.method()==='GET') return json(connection);
      if (path === '/v1/connections/personal') return json({ connections: [state.id.personal,...(state.multiplePersonal?[state.id.otherPersonal]:[])].map(id=>({id,appId:'github',name:`Fixture personal ${id.slice(0,8)}`,personal:true,status:'active',version:'fixture'})) });
      if (path === '/v1/apps/github/connection-schema') return json({ methods: [{ index: 0, type: 'NO_AUTH', name: 'Fixture', description: '', fields: [], ready: true }] });
      if ([state.id.personal,state.id.otherPersonal].some(id=>path===`/v1/connections/personal/${id}/actions`)) return json({ actions: [{ name: 'getIssueInformation', displayName: 'Get issue information', description: 'Reviewed read-only fixture action', shareable: true, fields: [] }] });
      if ([state.id.personal,state.id.otherPersonal].some(id=>path===`/v1/connections/personal/${id}/sharing`)) return json({ recipients: state.recipients, grants: path.includes(state.id.personal)?state.personalGrants:[] });
      if (path === `/v1/connections/personal/${state.id.personal}/grants` && request.method() === 'POST') {
        if(['FORBIDDEN','CONNECTION_INACTIVE','CSRF_REQUIRED'].includes(state.grantResponse)){state.grantStarted.resolve();return json({error:{code:state.grantResponse}},403);}
        state.grantStarted.resolve();
        if (state.grantGate) await state.grantGate.promise;
        if(state.grantResponse==='uncommitted')return route.abort('failed');
        const grant = { id: randomUUID(), recipientId: body.recipientId, actionName: body.actionName, expiresAt: body.expiresAt, revokedAt: null };
        state.personalGrants.push(grant);
        if (state.grantResponse === 'ambiguous') return route.abort('failed');
        if (state.grantResponse === 'server-error') return json({error:{code:'UNAVAILABLE'}},503);
        if (state.grantResponse === 'timeout') return json({error:{code:'REQUEST_TIMEOUT'}},408);
        if (state.grantResponse === 'malformed') return json({},201);
        return json({ id: grant.id }, 201);
      }
      if (path === `/v1/actions/github.get-issue.v1/run` || path === '/v1/apps/github/test') {
        assert.equal(request.method(), 'POST'); state.ownerReads++;
        return json({ result: { number: 12, title: 'Fixture owner read-only result', state: 'open' } });
      }
      throw new Error('unexpected-route');
    } catch {
      state.violations.push(`${request.method()} ${path}`); await route.abort().catch(() => {});
    }
  });
  try {
    await page.goto(origin + (settings.route ?? '/?tab=' + (settings.app ? `connections&app=${settings.app}` : 'agents')));
    const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
    step = 'wait Agents navigation';
    await button(nav, /^Agents$/).waitFor();
    if(!settings.raw) assert.equal(new URL(page.url()).searchParams.get('tab'), settings.app ? 'connections' : 'agents');
    if (settings.app) await page.locator('summary').filter({ hasText: /^Who can use this app\?$/ }).click();
    const panel = visible(page.locator('.action-access'));
    step = 'wait agent management panel';
    if(!settings.raw) await panel.waitFor();
    step = 'wait existing agent choices';
    if(!settings.raw) await panel.getByRole('combobox', { name: labels.agent }).waitFor();
    step = 'wait agent metadata idle';
    if(!settings.raw) await page.waitForFunction(() => document.querySelector('.action-access')?.getAttribute('aria-busy') === 'false');
    await run({ page, panel, state, context, settings });
    verifyWrites(state);
    results.push({ name, passed: true, fixtureOnly: true });
  } catch (error) {
    // Only controlled test names/steps and error categories become evidence. Playwright diagnostics
    // can contain DOM/key material, so never print its message/stack or attach a failure screenshot.
    const assertion = error instanceof assert.AssertionError || (settings.personal && state.sentinels.length === 0) ? error.message.split('\n')[0].replace(/ck_agent_[A-Za-z0-9_-]{43}/gu, '[redacted]') : undefined;
    results.push({ name, passed: false, fixtureOnly: true, step, violations: state.violations, requestPaths: state.requests.map(r => `${r.method} ${r.path}`), error: error instanceof assert.AssertionError ? 'assertion' : error.name === 'TimeoutError' ? 'timeout' : 'fixture-error', ...(assertion ? { assertion } : {}) });
  } finally {
    state.keyGate?.resolve(); state.grantGate?.resolve(); state.connectionGate?.resolve(); state.accessGate?.resolve(); state.appsGate?.resolve(); await context.close();
  }
}
let getAsset;
async function reach(panel, find) {
  await openSetup(panel);
  for (let count = 0; count < 5; count++) {
    const target = find();
    if (await target.count()) return target;
    const next = button(panel, labels.next);
    assert.ok(await next.count(), 'Expected the documented next-step control.');
    assert.ok(await next.first().isEnabled(), 'Prerequisite step is not complete.');
    await next.first().click();
  }
  assert.fail('Expected setup control was not reached.');
}
async function chooseAgent({ panel, state }, identity = 'a') {
  await openSetup(panel);
  step = 'select existing agent by UUID';
  const existing = button(panel, labels.existing);
  if (await existing.count()) await existing.first().click();
  const radios = visible(panel.getByRole('radio', { name: labels.existing }));
  if (await radios.count()) await radios.first().check();
  const choice = await reach(panel, () => visible(panel.getByRole('combobox', { name: labels.agent })));
  const options = await choice.first().locator('option').evaluateAll(nodes => nodes.map(node => ({ id: node.value, text: node.textContent })));
  assert.ok(options.some(option => option.id === state.id.a) && options.some(option => option.id === state.id.b), 'Duplicate-name identities must both be available.');
  const a = options.find(option => option.id === state.id.a), b = options.find(option => option.id === state.id.b);
  assert.notEqual(a.text, b.text, 'Duplicate names must be disambiguated with stable identity metadata.');
  assert.ok(a.text.includes(state.id.a) || a.text.includes(state.id.a.slice(0, 8)), 'The agent ID must be visible.');
  await choice.first().selectOption(state.id[identity]);
}
async function openSetup(panel) {
  const setup=panel.locator('.agent-setup');
  if(await setup.count() && !(await setup.evaluate(node=>node.open)))await setup.locator(':scope > summary').click();
}
async function personalReview(test) {
  const personal=visible(test.page.locator('.personal-app'));
  await button(personal,/^Share an action$/).click();
  await personal.getByLabel('User or agent',{exact:true}).selectOption(test.state.id.a);
  await personal.getByLabel('Action',{exact:true}).selectOption('getIssueInformation');
  await personal.getByRole('checkbox',{name:/^I approve this exact personal/}).check();
  return {personal,submit:button(personal,/^Share action$/)};
}
async function reopenPersonal(test) {
  await button(test.page,/^← All apps$/).click();
  await button(test.page,/^GitHub.*Connected/s).first().click();
  return visible(test.page.locator('.personal-app'));
}
async function createAgent({ panel }, name = 'Fixture new agent') {
  step = 'select new identity';
  const choice = button(panel, labels.newAgent);
  if (await choice.count()) await choice.first().click();
  const radio = visible(panel.getByRole('radio', { name: labels.newAgent }));
  if (await radio.count()) await radio.first().check();
  const field = await reach(panel, () => visible(panel.getByLabel(labels.name)));
  await field.first().fill(name);
}
async function issueControl(panel) { return (await reach(panel, () => button(panel, labels.issue))).first(); }
async function issueKey(test) {
  step = 'issue key'; await (await issueControl(test.panel)).click();
  await button(test.panel, labels.saved).first().waitFor();
  await secretPresent(test.page, test.state, true);
}
async function secretPresent(page, state, expected) {
  const present = await page.evaluate(values => values.some(value => document.documentElement.textContent.includes(value) || [...document.querySelectorAll('input,textarea')].some(node => node.value.includes(value))), state.sentinels);
  assert.equal(present, expected, 'One-time credential visibility violated.');
  const persisted = await page.evaluate(values => [localStorage, sessionStorage].some(storage => Object.values(storage).some(value => values.some(secret => value.includes(secret)))), state.sentinels);
  assert.equal(persisted, false, 'Credentials must not be persisted in web storage.');
}
async function acknowledge(test) {
  step = 'explicit saved acknowledgement';
  const saved = visible(test.panel.getByRole('checkbox', { name: /^I saved this key in secure secret storage\./i }));
  if (await saved.count()) {
    assert.ok(await button(test.panel, labels.saved).first().isDisabled(), 'Continuing requires explicit secure-storage acknowledgement.');
    await saved.check();
  }
  await button(test.panel, labels.saved).first().click();
  await secretPresent(test.page, test.state, false);
}
async function grantFields(test) {
  step = 'choose exact grant scope';
  const action = await reach(test.panel, () => visible(test.panel.getByRole('combobox', { name: /^Action$/i })));
  await action.first().selectOption('github.get-issue.v1');
  const recipient = visible(test.panel.getByRole('combobox', { name: /^(Recipient|User or agent)$/i }));
  if (await recipient.count()) await recipient.first().selectOption(test.state.id.a);
  await visible(test.panel.getByRole('combobox', { name: /^(Connected account|Connection|GitHub connection)$/i })).first().selectOption(test.state.id.connection);
  const repository = test.panel.getByRole('checkbox', { name: /^fixture\/first(?: · 101)?$/ });
  await repository.waitFor();
  return { repository, action: action.first(), recipient, consent: visible(test.panel.getByRole('checkbox', { name: labels.consent })).first(), submit: button(test.panel, labels.grant).first() };
}
async function approveGrant(test) {
  const fields = await grantFields(test);
  assert.equal(await fields.repository.isChecked(), false, 'Repositories require an explicit choice.');
  assert.ok(await fields.submit.isDisabled());
  await fields.repository.check(); await fields.consent.check();
  assert.ok(await fields.submit.isEnabled()); return fields;
}
async function waitForMutation(page, path, run) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  await run(); await response;
}
async function unknownReadiness(panel) {
  step = 'client readiness remains unknown';
  const text = await panel.innerText();
  assert.match(text, /(?:client|agent|connection).{0,80}(?:unknown|not (?:yet )?verified|not checked|unverified)|(?:unknown|not (?:yet )?verified|not checked|unverified).{0,80}(?:client|agent|connection)/isu, 'Issuance/grants/owner tests are not evidence of client readiness.');
  assert.doesNotMatch(text, /client (?:is )?(?:verified|connected successfully|ready to run)|agent connected successfully/iu);
}
async function reconcile(test) {
  step = 'explicit metadata reconciliation without mutation retry';
  const before = keyPosts(test.state).length + grantPosts(test.state).length;
  const reads = test.state.requests.filter(request => request.path === '/v1/action-access').length;
  test.state.failRefresh = false;
  const refresh = button(test.panel, labels.refresh).first();
  await refresh.waitFor();
  const response = test.page.waitForResponse(response => new URL(response.url()).pathname === '/v1/action-access');
  await refresh.click(); await response;
  assert.ok(test.state.requests.filter(request => request.path === '/v1/action-access').length > reads);
  assert.equal(keyPosts(test.state).length + grantPosts(test.state).length, before, 'Reconciliation must never replay a mutation.');
}
async function visualGeometry(page) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal document overflow.');
  const invalid=await page.locator('button,[role="button"],input,select,summary').filter({visible:true}).evaluateAll(nodes=>nodes.filter(node=>{
    const box=node.getBoundingClientRect(),label=node.labels?.[0],target=node.matches('input[type="checkbox"],input[type="radio"]')&&label?label.getBoundingClientRect():box;
    return target.height<44||target.width<44||box.left < -1||box.right>innerWidth+1;
  }).length);
  assert.equal(invalid,0,'Interactive targets must be >=44px and in bounds.');
}
async function capture(test,name) {
  const {page,state,settings}=test,dir=process.env.CAPYKIT_AGENT_VISUAL_DIR;
  assert.ok(dir,'Set CAPYKIT_AGENT_VISUAL_DIR for retained evidence.');
  // A reveal uses sentinel keys only. Never retain their bytes, even in screenshots.
  assert.equal(await page.evaluate(values=>values.some(value=>document.documentElement.textContent.includes(value)),state.sentinels),false);
  await page.evaluate(()=>document.fonts.ready);
  await mkdir(dir,{recursive:true});
  const file=`${name}-${settings.width??375}-${settings.theme??'system'}.png`;
  const fields=page.locator('input,textarea');
  // Full-page pixel masks can drift when focused inputs scroll. Redact the fixture
  // DOM values for capture only; never rely on a rectangle hiding the secret.
  const revealing=state.sentinels.length>0&&await fields.evaluateAll((nodes,values)=>nodes.some(node=>values.includes(node.value)),state.sentinels);
  const originals=revealing?await fields.evaluateAll(nodes=>nodes.map(node=>node.value)):null;
  if(originals)await fields.evaluateAll(nodes=>{for(const node of nodes){node.value='[REDACTED FIXTURE VALUE]';if(node instanceof HTMLInputElement&&['text','password','search'].includes(node.type))node.setSelectionRange(0,0);}});
  try{await page.screenshot({path:join(dir,file),fullPage:true});}
  finally{if(originals)await fields.evaluateAll((nodes,values)=>{nodes.forEach((node,index)=>{node.value=values[index];});},originals);}
  if(state.sentinels.length)await secretPresent(page,state,revealing);
  screenshots.push({file,route:new URL(page.url()).pathname+new URL(page.url()).search,viewport:page.viewportSize(),theme:settings.theme??'system',mediaPreference:settings.media??'light',fixtureOnly:true,credentialValuesRedacted:revealing,redactionMethod:revealing?'DOM input values replaced for capture only; restored after screenshot':null,buildSha256:evidenceMetadata.buildSha256});
}
async function describeBuild() {
  assert.notEqual(process.env.CAPYKIT_AGENT_SOURCE,'1','Visual proof must use built Vite assets.');
  await mkdir(process.env.CAPYKIT_AGENT_VISUAL_DIR,{recursive:true});
  const directory=resolve(process.env.CAPYKIT_CONSOLE_DIR??join(root,'dist/console'));
  const files=['index.html',...(await readdir(join(directory,'assets'))).sort().map(name=>`assets/${name}`)];
  const hash=createHash('sha256'),assetHashes={};
  for(const file of files){const bytes=await readFile(join(directory,file));hash.update(file);hash.update(bytes);assetHashes[file]=createHash('sha256').update(bytes).digest('hex');}
  evidenceMetadata={phase:baseline?'before':'after',revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),revisionMeaning:'HEAD identifies repository revision; buildSha256 identifies exact served Vite bytes including any uncommitted implementation.',buildSha256:hash.digest('hex'),assetHashes,browserVersion:browser.version(),nodeVersion:process.version,astryxVersion:'0.7.0',fixtureOnly:true,liveBackendVerified:false,providerVerified:false,physicalDeviceVerified:false,independentReview:false,implementationModel:'gpt-6.1-sol',pluginRevision:'08359024b405bf92afc3b4624675415384b67e5a',screenshots};
}
async function visualChecks() {
  await describeBuild();
  for(const width of baseline?[375,1440]:[320,375,430,1440]) for(const theme of ['light','dark']) {
    await check(`Visual Agents list/detail ${width} ${theme}`,{width,theme},async test=>{
      if(!baseline){await visualGeometry(test.page);assert.ok(await test.panel.locator('.astryx-list').count());}
      await capture(test,'agents-list');await chooseAgent(test,'b');await unknownReadiness(test.panel);
      await visualGeometry(test.page);await capture(test,'agents-detail');
      await openSetup(test.panel);await visualGeometry(test.page);
      if(!baseline&&width===375){await capture(test,'agents-setup');
        const rotate=button(test.panel,/^Replace this key$/).first();await rotate.focus();await test.page.keyboard.press('Enter');
        const dialog=test.page.getByRole('dialog',{name:'Replace this exact key?'});await dialog.waitFor();
        const cancel=button(dialog,/^Cancel$/);await cancel.focus();await test.page.keyboard.press('Escape');
        await dialog.waitFor({state:'hidden'});assert.ok(await rotate.evaluate(node=>document.activeElement===node),'Escape restores the exact trigger.');
        await test.page.keyboard.press('Enter');await visualGeometry(test.page);await capture(test,'exact-key-dialog');
        await button(dialog,/^Confirm exact key replacement$/).click();await button(test.panel,labels.saved).waitFor();
        await secretPresent(test.page,test.state,true);await visualGeometry(test.page);await capture(test,'one-time-key-masked');
        await acknowledge(test);await unknownReadiness(test.panel);assert.equal(keyPosts(test.state).length,1);
      }
    });
    await check(`Visual Apps list/search/account ${width} ${theme}`,{width,theme,raw:true,route:'/?tab=connections'},async test=>{
      const {page}=test;await page.getByRole('status').filter({hasText:'matching integrations'}).waitFor();await visualGeometry(page);await capture(test,'apps-list');
      const search=page.getByLabel('Search apps',{exact:true});await search.fill('Google');
      await page.getByRole('status').filter({hasText:'1 matching integrations'}).waitFor();await button(page,/^Google Drive.*Connected/s).click();
      await page.getByRole('heading',{name:'Connected account',exact:true}).waitFor();await visualGeometry(page);await capture(test,'drive-account');
      if(!baseline){const disconnect=button(page,/^Disconnect$/);await disconnect.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Disconnect Google Drive',exact:true});await dialog.waitFor();
        await button(dialog,/^Keep connected$/).focus();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.ok(await disconnect.evaluate(node=>document.activeElement===node));}
      assert.ok(test.state.requests.every(r=>['GET','HEAD'].includes(r.method)),'Search/open/cancel must not mutate.');
    });
  }
  if(baseline)return;
  for(const theme of ['light','dark']) {
    await check(`Visual GitHub confirmation focus restore ${theme}`,{width:375,theme,raw:true,route:'/?tab=connections&app=github'},async test=>{
      const {page}=test;await page.locator('.connection-management > summary').click();
      await page.getByRole('navigation',{name:'Connections',exact:true}).getByRole('button',{name:/Fixture GitHub/}).click();
      const detail=page.getByRole('region',{name:'Connection details',exact:true});await detail.waitFor();
      for(const [label,name,cancel]of [['Disconnect','Disconnect GitHub','Cancel'],['Review and reconnect','Review and reconnect GitHub','Keep current connection']]){
        const trigger=button(detail,new RegExp(`^${label}$`));await trigger.focus();await page.keyboard.press('Enter');
        const dialog=page.getByRole('dialog',{name,exact:true});await dialog.waitFor();await visualGeometry(page);await capture(test,`github-${label==='Disconnect'?'disconnect':'reconnect'}-dialog`);
        await button(dialog,new RegExp(`^${cancel}$`)).focus();await page.keyboard.press('Space');await dialog.waitFor({state:'hidden'});
        assert.ok(await trigger.evaluate(node=>document.activeElement===node),'Cancelling restores the original GitHub trigger.');
      }
      assert.ok(test.state.requests.every(r=>['GET','HEAD'].includes(r.method)));
    });
    await check(`Visual personal confirmation focus and exact sharing ${theme}`,{width:375,theme,raw:true,route:'/?tab=connections&app=github',personal:true},async test=>{
      const {page}=test,personal=page.getByRole('region',{name:'GitHub personal connections',exact:true});await personal.waitFor();
      const trigger=button(personal,/^Disconnect$/);await trigger.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Disconnect personal account',exact:true});await dialog.waitFor();
      await capture(test,'personal-disconnect-dialog');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.ok(await trigger.evaluate(node=>document.activeElement===node));
      await personalReview(test);await visualGeometry(page);await capture(test,'personal-exact-sharing');
      assert.ok(test.state.requests.every(r=>['GET','HEAD'].includes(r.method)));
    });
    for(const route of ['agents','connections']) for(const state of ['empty','error','loading']) {
      const settings={width:375,theme,raw:true,route:`/?tab=${route}`,...route==='agents'?state==='empty'?{emptyAgents:true}:state==='error'?{failRefresh:true}:{accessGate:deferred()}:state==='empty'?{emptyApps:true}:state==='error'?{appsError:true}:{appsGate:deferred()}};
      await check(`Visual ${route} ${state} ${theme}`,settings,async test=>{
        const scope=route==='agents'?test.panel:test.page.locator('.apps');
        if(state==='loading')await scope.getByRole('status',{name:route==='agents'?'Loading agent metadata…':'Loading apps…',exact:true}).waitFor();
        else if(state==='error')await scope.getByRole('alert').waitFor();
        else await scope.getByText(route==='agents'?'No agent identities in the current metadata.':'No connected apps yet',{exact:true}).waitFor();
        await visualGeometry(test.page);await capture(test,`${route}-${state}`);
        if(state==='loading'){test.state.accessGate?.resolve();test.state.appsGate?.resolve();}
        if(state==='error'){test.state.failRefresh=false;test.state.appsError=false;await button(test.page,route==='agents'?labels.refresh:/^Refresh apps$/).click();}
      });
    }
    for(const unavailable of [false,true])await check(`Visual Drive ${unavailable?'not configured':'reconnect'} ${theme}`,{width:375,theme,raw:true,route:'/?tab=connections&app=google-drive',unconfiguredDrive:unavailable,reconnectDrive:!unavailable},async test=>{
      const heading=test.page.getByRole('heading',{name:unavailable?'Google Drive isn’t available yet':'Reconnect Google Drive',exact:true});await heading.waitFor();
      await visualGeometry(test.page);await capture(test,unavailable?'drive-unavailable':'drive-reconnect');assert.equal(keyPosts(test.state).length,0);
    });
  }
  for(const media of ['light','dark'])await check(`Visual system appearance follows ${media}`,{width:375,theme:'system',media},async test=>{
    await visualGeometry(test.page);assert.equal(await test.page.locator('html').getAttribute('data-theme'),null);
    await capture(test,`system-${media}`);await test.page.emulateMedia({colorScheme:media==='light'?'dark':'light'});
    await unknownReadiness(test.panel);
  });
  await replacementRecoveryChecks(true);
  await modalRecoveryChecks(true);
}
async function replacementRecoveryChecks(retain=false) {
  for(const outcome of ['ambiguous','denied'])for(const theme of ['light','dark']) {
    await check(`Exact-key ${outcome} response closes modal and focuses keyboard reconciliation ${theme}`,{width:375,theme,keyResponse:outcome,keyGate:deferred()},async test=>{
      await chooseAgent(test);
      const {page,panel,state}=test,beforeKeys=structuredClone(state.keys),beforeGrants=structuredClone(state.grants),beforeRecipients=structuredClone(state.recipients);
      const rotate=button(panel.locator(`[data-key-id="${state.id.a1}"]`),/^Replace this key$/);
      await rotate.focus();await page.keyboard.press('Enter');
      const dialog=page.getByRole('dialog',{name:'Replace this exact key?',exact:true});await dialog.waitFor();
      for(const id of [state.id.a,state.id.a1])assert.ok((await dialog.innerText()).includes(id));
      await button(dialog,/^Confirm exact key replacement$/).evaluate(node=>{node.click();node.click();});
      await completed(state.keyStarted.promise);assert.equal(keyPosts(state).length,1);
      await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),1,'Pending writes cannot dismiss confirmation.');
      state.keyGate.resolve();
      step='failed exact-key modal releases recovery focus';
      await visible(panel.getByRole('alert')).first().waitFor();
      await dialog.waitFor({state:'hidden'});
      const reload=button(panel,labels.refresh);
      await page.waitForFunction(()=>document.activeElement?.textContent==='Reload metadata');
      assert.ok(await reload.isEnabled());
      assert.equal(keyPosts(state).length,1);assert.equal(keyPosts(state)[0].body.rotateKeyId,state.id.a1);
      assert.equal(keyPosts(state)[0].body.principalId,undefined);assert.equal(keyPosts(state)[0].body.name,undefined);
      if(outcome==='ambiguous'){
        assert.ok(await rotate.isDisabled(),'Uncertainty pauses replacement until metadata reconciliation.');
        assert.equal(state.keys.find(k=>k.id===state.id.a1).status,'revoked');
        assert.equal(state.keys[0].principalId,state.id.a);
      }else{
        assert.deepEqual(state.keys,beforeKeys,'Denied replacement must not change keys.');
        assert.doesNotMatch(await panel.innerText(),/Reconcile before changing access|outcome is unknown/u);
      }
      await unknownReadiness(panel);await secretPresent(page,state,false);
      if(retain){await visualGeometry(page);await capture(test,`exact-key-${outcome}-recovery`);}
      if(outcome==='denied'){
        await rotate.focus();await page.keyboard.press('Enter');await dialog.waitFor();
        await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
        assert.ok(await rotate.evaluate(node=>document.activeElement===node),'A stale denial must not steal Cancel/Escape restoration from the exact trigger.');
        await reload.focus();
      }
      // Exercise recovery through real keyboard activation, never a forced click behind a modal.
      if(outcome==='ambiguous'){
        state.failRefresh=true;await page.keyboard.press('Enter');
        await panel.getByRole('alert').filter({hasText:'Could not load current agent metadata'}).waitFor();
        await page.waitForFunction(()=>document.activeElement?.textContent==='Reload metadata');
        assert.ok(await rotate.isDisabled());assert.equal(keyPosts(state).length,1);
      }
      state.failRefresh=false;
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/v1/action-access');
      await page.keyboard.press('Enter');await response;
      await page.waitForFunction(()=>document.querySelector('.action-access')?.getAttribute('aria-busy')==='false');
      assert.equal(keyPosts(state).length,1,'Recovery never replays the write.');
      assert.deepEqual(state.grants,beforeGrants);assert.deepEqual(state.recipients,beforeRecipients);
      for(const id of [state.id.a2,state.id.b1])assert.deepEqual(state.keys.find(k=>k.id===id),beforeKeys.find(k=>k.id===id));
      await openSetup(panel);assert.equal(await panel.getByLabel('Existing agent',{exact:true}).inputValue(),state.id.a);
      await secretPresent(page,state,false);await unknownReadiness(panel);
    });
  }
}
async function modalRecoveryChecks(retain=Boolean(process.env.CAPYKIT_AGENT_VISUAL_DIR)) {
  for (const theme of ['light', 'dark']) {
    for (const kind of ['google', 'personal', 'github', 'reconnect']) {
      await check(`${kind} rejected confirmation exposes keyboard recovery ${theme}`, {
        width: 320, theme, raw: true, personal: kind === 'personal',
        route: '/?tab=connections&app=' + (kind === 'google' ? 'google-drive' : 'github'),
        connectionError: kind === 'reconnect' ? 'GITHUB_SELECTED_REPOSITORIES_REQUIRED' : 'FORBIDDEN', connectionGate: deferred(),
      }, async test => {
        const { page, state } = test;
        const beforeKeys=structuredClone(state.keys),beforeGrants=structuredClone(state.grants);
        let scope=page;
        if (kind === 'personal') {scope=page.getByRole('region',{name:'GitHub personal connections',exact:true});await scope.waitFor();}
        if (kind === 'github' || kind === 'reconnect') {
          await page.locator('.connection-management > summary').click();
          await page.getByRole('navigation',{name:'Connections',exact:true}).getByRole('button',{name:/Fixture GitHub/}).click();
          scope=page.getByRole('region',{name:'Connection details',exact:true});await scope.waitFor();
        }
        step='open exact connection confirmation';
        const trigger=button(scope,kind === 'reconnect' ? /^Review and reconnect$/ : /^Disconnect$/);
        await trigger.focus();await page.keyboard.press('Enter');
        const dialog=page.getByRole('dialog',{name:kind === 'google' ? 'Disconnect Google Drive' : kind === 'personal' ? 'Disconnect personal account' : kind === 'github' ? 'Disconnect GitHub' : 'Review and reconnect GitHub',exact:true});
        await dialog.waitFor();assert.equal(await dialog.getByRole('alert').count(),0);
        const submit=button(dialog,kind === 'reconnect' ? /^Continue with GitHub$/ : /^Confirm disconnect$/);
        await submit.focus();await page.keyboard.press('Enter');await completed(state.connectionStarted.promise);
        step='pending connection request blocks duplicate submit and Escape';
        const pending=page.locator('dialog[open]');
        assert.equal(await pending.getByRole('button').filter({visible:true}).evaluateAll(nodes=>nodes.every(node=>node.disabled)),true);
        await page.keyboard.press('Enter');await page.keyboard.press('Escape');
        assert.equal(await pending.count(),1);
        const writes=()=>state.requests.filter(r=>r.method==='DELETE'||r.path==='/v1/connections/github/start');
        assert.equal(writes().length,1);
        assert.equal(writes()[0].path,kind === 'google' ? '/v1/connections/google' : kind === 'personal' ? `/v1/connections/personal/${state.id.personal}` : kind === 'github' ? `/v1/connections/${state.id.connection}` : '/v1/connections/github/start');
        if (kind === 'reconnect') assert.deepEqual(writes()[0].body,{connectionId:state.id.connection});
        state.connectionGate.resolve();
        step='rejected connection shows one reachable modal alert';
        await dialog.getByRole('alert').waitFor();await submit.waitFor();
        await page.waitForFunction(()=>[...document.querySelectorAll('dialog[open] button')].every(node=>!node.disabled));
        assert.equal(await page.getByRole('alert').count(),1,'Only the active dialog announces its error.');
        assert.equal(await page.locator('[role="alert"]').count(),1,'The outer error must not be duplicated.');
        assert.match(await dialog.getByRole('alert').innerText(),kind === 'reconnect' ? /Only select repositories/ : kind === 'personal' ? /no longer have permission/ : /workspace owner/);
        if (kind === 'reconnect') {
          const recovery=dialog.getByRole('link',{name:'Manage GitHub access ↗',exact:true});
          assert.equal(await recovery.getAttribute('href'),'https://github.com/apps/fixture/installations/new');
          await recovery.focus();assert.ok(await recovery.evaluate(node=>document.activeElement===node));
        }
        const cancel=button(dialog,kind === 'google' || kind === 'personal' ? /^Keep connected$/ : kind === 'github' ? /^Cancel$/ : /^Keep current connection$/);
        await cancel.focus();assert.ok(await cancel.evaluate(node=>document.activeElement===node));
        await visualGeometry(page);
        if (retain) await capture(test,`${kind}-rejected-dialog`);
        await page.keyboard.press('Enter');await dialog.waitFor({state:'hidden'});
        assert.ok(await trigger.evaluate(node=>document.activeElement===node));
        assert.equal(writes().length,1,'Recovery does not replay a rejected request.');
        await page.keyboard.press('Enter');await dialog.waitFor();
        assert.equal(await dialog.getByRole('alert').count(),0,'Opening a new confirmation clears stale errors.');
        await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
        assert.deepEqual(state.keys,beforeKeys);assert.deepEqual(state.grants,beforeGrants);
      });
    }
    for (const elapsed of [false,true]) {
      await check(`Replacement expiry ${elapsed ? 'passes while confirming' : 'is already past with setup closed'} focuses editable field ${theme}`,{width:320,theme},async test=>{
        const {page,panel,state}=test;
        await chooseAgent(test);await openSetup(panel);
        const beforeKeys=structuredClone(state.keys),beforeGrants=structuredClone(state.grants),beforeRecipients=structuredClone(state.recipients);
        const expiry=panel.getByLabel('Access expires',{exact:true});
        await expiry.fill(elapsed ? '2026-10-15T11:31' : '2026-10-14T10:00');
        await panel.locator('.agent-setup > summary').click();
        const rotate=button(panel.locator(`[data-key-id="${state.id.a1}"]`),/^Replace this key$/);
        await rotate.focus();await page.keyboard.press('Enter');
        const dialog=page.getByRole('dialog',{name:'Replace this exact key?',exact:true});
        if (elapsed) {
          await dialog.waitFor();
          for (const id of [state.id.a,state.id.a1]) assert.ok((await dialog.innerText()).includes(id));
          await page.clock.setFixedTime(new Date(fixedNow.getTime()+120000));
          await button(dialog,/^Confirm exact key replacement$/).focus();await page.keyboard.press('Enter');
        }
        step='invalid expiry restores focus without a request';
        await panel.getByRole('alert').filter({hasText:'Choose a valid future local expiry within one year.'}).waitFor();
        await dialog.waitFor({state:'hidden'});
        await page.waitForFunction(()=>document.activeElement?.getAttribute('type')==='datetime-local');
        assert.equal(await panel.locator('.agent-setup').evaluate(node=>node.open),true);
        assert.ok(await expiry.isEnabled());assert.equal(keyPosts(state).length,0);
        await visualGeometry(page);
        if (retain) await capture(test,`replacement-expiry-${elapsed?'elapsed':'past'}-recovery`);
        // Repeating validation with the same error still returns keyboard focus.
        await panel.locator('.agent-setup > summary').click();
        await rotate.focus();await page.keyboard.press('Enter');
        assert.ok(await expiry.evaluate(node=>document.activeElement===node));
        await expiry.fill('2026-11-01T10:00');
        await rotate.focus();await page.keyboard.press('Enter');await dialog.waitFor();
        assert.equal(await panel.getByRole('alert').count(),0,'Corrected expiry must not retain the stale validation error.');
        for (const id of [state.id.a,state.id.a1]) assert.ok((await dialog.innerText()).includes(id));
        await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
        assert.ok(await rotate.evaluate(node=>document.activeElement===node),'Corrected expiry cancellation restores the exact replacement trigger.');
        assert.equal(keyPosts(state).length,0);assert.deepEqual(state.keys,beforeKeys);assert.deepEqual(state.grants,beforeGrants);assert.deepEqual(state.recipients,beforeRecipients);
        await secretPresent(page,state,false);
      });
    }
  }
}
async function main() {
  const { chromium } = await loadPlaywright();
  getAsset = await assets();
  const executablePath = await chromiumPath();
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox'] });
  if(visualOnly){await visualChecks();return;}
  if(process.env.CAPYKIT_AGENT_VISUAL_DIR)await describeBuild();
  await check('Agents route and owner entry point', {}, async ({ page }) => {
    step = 'Agents navigation is current';
    assert.equal(await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Agents', exact: true }).getAttribute('aria-current'), 'page');
  });
  if (!results[0].passed) return; // Missing integration is a blocker, not dozens of invented results.
  await replacementRecoveryChecks();
  await modalRecoveryChecks();
  await check('Existing duplicate-name identity reuse does not create another principal', { noActiveFor: 'b' }, async test => {
    await chooseAgent(test, 'b'); const recipients = structuredClone(test.state.recipients);
    await issueKey(test);
    const post = keyPosts(test.state).at(-1).body;
    assert.equal(post.principalId, test.state.id.b); assert.equal(post.name, undefined); assert.equal(post.rotateKeyId, undefined);
    assert.deepEqual(test.state.recipients, recipients);
    await acknowledge(test); await unknownReadiness(test.panel);
  });
  await check('Create identity and key is distinct from identity reuse', {}, async test => {
    await createAgent(test); await issueKey(test);
    assert.equal(keyPosts(test.state).length, 1); assert.equal(keyPosts(test.state)[0].body.name, 'Fixture new agent');
    assert.equal(keyPosts(test.state)[0].body.principalId, undefined);
    await acknowledge(test);
  });
  await check('Same-name creation warning offers the exact existing identities', {}, async test => {
    await createAgent(test, 'Same agent name');
    await test.panel.getByRole('status').filter({ hasText: 'An agent with this name already exists' }).waitFor();
    await button(test.panel, new RegExp(`^Use ${test.state.id.a.slice(0, 8)}`)).click();
    assert.equal(await test.panel.getByLabel('Existing agent', { exact: true }).inputValue(), test.state.id.a);
    assert.equal(keyPosts(test.state).length, 0);
  });
  await check('Expired and revoked metadata stay in collapsed history with exact recovery controls', {}, async test => {
    test.state.keys[0].status = 'expired'; test.state.keys[1].status = 'revoked';
    await reconcile(test); await chooseAgent(test);
    const summary = test.panel.locator('summary').filter({ hasText: /^Key history$/ });
    const history = summary.locator('..');
    assert.equal(await history.getAttribute('open'), null);
    await summary.click();
    assert.equal(await button(history, /^Replace this key$/).count(), 1);
    for(const detail of await history.locator('.agent-key-card > details > summary').all())await detail.click();
    assert.ok((await history.innerText()).includes(test.state.id.a1));
    assert.ok((await history.innerText()).includes(test.state.id.a2));
    await unknownReadiness(test.panel);
  });
  await check('Exact-key rotation preserves principal, sibling keys and all grants', { keyGate: deferred() }, async test => {
    await chooseAgent(test);
    const beforeGrants = structuredClone(test.state.grants), beforeKeys = structuredClone(test.state.keys);
    step = 'select rotation by exact key metadata';
    const controls = await reach(test.panel, () => button(test.panel, /Rotate(?: key)?|Replace this key/i));
    const matching = controls.filter({ hasText: test.state.id.a1 });
    let rotate = matching;
    if (!(await rotate.count())) {
      const card = visible(test.panel.locator(`[data-key-id="${test.state.id.a1}"]`));
      rotate = button(card, /Rotate(?: key)?|Replace this key/i);
    }
    assert.equal(await rotate.count(), 1, 'Rotation controls must identify the full exact key ID.');
    await rotate.click();
    const confirm = button(test.panel, /^(Confirm rotation|Confirm exact key replacement)$/i).first(); await confirm.waitFor();
    assert.ok((await test.panel.getByRole('region', { name: 'Confirm exact access change' }).innerText()).includes(test.state.id.a1));
    await button(test.panel, /^Cancel$/i).click(); assert.equal(keyPosts(test.state).length, 0);
    await rotate.click();
    step = 'synchronous duplicate exact rotation confirmation';
    await confirm.evaluate(node => { node.click(); node.click(); });
    await completed(test.state.keyStarted.promise); assert.equal(keyPosts(test.state).length, 1);
    test.state.keyGate.resolve();
    await button(test.panel, labels.saved).first().waitFor();
    assert.equal(keyPosts(test.state).length, 1); assert.equal(keyPosts(test.state)[0].body.rotateKeyId, test.state.id.a1);
    assert.equal(keyPosts(test.state)[0].body.principalId, undefined); assert.equal(keyPosts(test.state)[0].body.name, undefined);
    assert.equal(test.state.keys[0].principalId, test.state.id.a);
    assert.equal(test.state.keys.find(key => key.id === test.state.id.a1).status, 'revoked');
    for (const id of [test.state.id.a2, test.state.id.b1]) assert.deepEqual(test.state.keys.find(key => key.id === id), beforeKeys.find(key => key.id === id));
    assert.deepEqual(test.state.grants, beforeGrants); await secretPresent(test.page, test.state, true); await acknowledge(test);
  });
  await check('Malformed issuance without one-time key is not setup success', { keyResponse: 'missing' }, async test => {
    await chooseAgent(test, 'noKey'); await (await issueControl(test.panel)).click();
    step = 'missing-key recovery'; await visible(test.panel.getByRole('alert')).first().waitFor();
    assert.equal(await button(test.panel, labels.saved).count(), 0); await secretPresent(test.page, test.state, false);
    assert.equal(keyPosts(test.state).length, 1); await unknownReadiness(test.panel); await reconcile(test);
    assert.equal(keyPosts(test.state).length, 1);
  });
  await check('Clipboard rejection preserves key and requires separate saved acknowledgement', {}, async test => {
    await chooseAgent(test, 'noKey'); await issueKey(test);
    await test.page.evaluate(() => { window.__fixtureClipboard.fail = true; });
    step = 'clipboard failure'; await button(test.panel, labels.copy).first().click();
    await visible(test.panel.getByRole('status')).filter({ hasText: /Clipboard unavailable/i }).first().waitFor();
    assert.equal(await test.page.evaluate(() => window.__fixtureClipboard.calls), 1);
    await secretPresent(test.page, test.state, true);
    assert.equal(await button(test.panel, labels.issue).count(), 0, 'A pending key must block another issuance.');
    await acknowledge(test); await unknownReadiness(test.panel);
  });
  await check('Successful copy is not an explicit saved acknowledgement', {}, async test => {
    await chooseAgent(test, 'noKey'); await issueKey(test); await button(test.panel, labels.copy).first().click();
    assert.equal(await test.page.evaluate(() => window.__fixtureClipboard.calls), 1);
    await secretPresent(test.page, test.state, true); assert.ok(await button(test.panel, labels.saved).first().isDisabled());
    await acknowledge(test);
  });
  await check('Synchronous duplicate key submit issues once', { keyGate: deferred() }, async test => {
    await createAgent(test); const submit = await issueControl(test.panel);
    step = 'two submissions in the same browser task';
    await submit.evaluate(node => { const form = node.closest('form'); assertForm(form); form.requestSubmit(); form.requestSubmit(); function assertForm(form) { if (!form) throw new Error('No native form'); } });
    await completed(test.state.keyStarted.promise);
    assert.equal(keyPosts(test.state).length, 1); assert.ok(await submit.isDisabled());
    test.state.keyGate.resolve(); await button(test.panel, labels.saved).first().waitFor();
    assert.equal(keyPosts(test.state).length, 1); await acknowledge(test);
  });
  for (const failure of ['ambiguous', 'refresh', 'timeout']) {
    await check(`Key ${failure} completion reconciles metadata with no blind retry`, { keyResponse: failure === 'refresh' ? 'ok' : failure, failRefresh: false }, async test => {
      await chooseAgent(test, 'noKey');
      test.state.failRefresh = failure === 'refresh';
      step = 'uncertain key completion'; await (await issueControl(test.panel)).click();
      await visible(test.panel.getByRole('alert')).first().waitFor();
      assert.equal(keyPosts(test.state).length, 1);
      if (failure === 'refresh') { await secretPresent(test.page, test.state, true); await acknowledge(test); }
      else await secretPresent(test.page, test.state, false);
      await reconcile(test); assert.equal(keyPosts(test.state).length, 1);
      await unknownReadiness(test.panel);
    });
  }
  for (const leave of ['navigation', 'reload', 'pending-navigation']) {
    await check(`${leave} discards one-time secret and setup acknowledgement`, { keyGate: leave === 'pending-navigation' ? deferred() : null }, async test => {
      await chooseAgent(test, 'noKey');
      if (leave === 'pending-navigation') { await (await issueControl(test.panel)).click(); await completed(test.state.keyStarted.promise); }
      else await issueKey(test);
      step = 'leave setup';
      if (leave === 'reload') await test.page.reload();
      else {
        await test.page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Apps', exact: true }).click();
        if (test.state.keyGate) {
          const completedResponse = test.page.waitForResponse(response => new URL(response.url()).pathname === '/v1/agents/keys');
          test.state.keyGate.resolve(); await completedResponse;
        }
        await test.page.getByRole('heading', { name: 'Apps', exact: true }).waitFor();
        await test.page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Agents', exact: true }).click();
      }
      await test.panel.waitFor(); await secretPresent(test.page, test.state, false);
      assert.equal(await button(test.panel, labels.saved).count(), 0);
      assert.equal(keyPosts(test.state).length, 1);
      if (leave === 'reload') await chooseAgent(test, 'noKey');
      await unknownReadiness(test.panel);
    });
  }
  await check('Page hiding and pagehide discard an unsaved one-time key', {}, async test => {
    await chooseAgent(test, 'noKey'); await issueKey(test);
    step = 'privacy lifecycle clears secret';
    await test.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
      delete document.visibilityState;
    });
    await secretPresent(test.page, test.state, false);
    assert.equal(await button(test.panel, labels.saved).count(), 0);
    assert.equal(keyPosts(test.state).length, 1); await reconcile(test); await unknownReadiness(test.panel);
  });
  await check('Exact repository grant and consent reset on every scope edit', {}, async test => {
    await chooseAgent(test); const fields = await grantFields(test);
    step = 'repository and exact-scope consent';
    assert.equal(await fields.repository.isChecked(), false); assert.ok(await fields.submit.isDisabled());
    await fields.repository.check(); await fields.consent.check(); assert.ok(await fields.submit.isEnabled());
    const second = test.panel.getByRole('checkbox', { name: /^fixture\/second(?: · 102)?$/ });
    await second.check(); assert.equal(await fields.consent.isChecked(), false); assert.ok(await fields.submit.isDisabled());
    await second.uncheck(); await fields.consent.check();
    const connection = visible(test.panel.getByRole('combobox', { name: /^(Connected account|Connection|GitHub connection)$/i })).first();
    await connection.selectOption(test.state.id.otherConnection); assert.equal(await fields.consent.isChecked(), false);
    assert.equal(await test.panel.getByRole('checkbox', { checked: true }).count(), 0);
    await connection.selectOption(test.state.id.connection); await fields.repository.check(); await fields.consent.check();
    const expires = visible(test.panel.locator('input[type="datetime-local"]')).last();
    await expires.fill('2026-11-01T11:45'); assert.equal(await fields.consent.isChecked(), false);
    await fields.consent.check(); await fields.action.selectOption('drive.get-file.v1');
    assert.ok(await fields.submit.isDisabled()); assert.equal(await fields.consent.count(), 0);
    const fresh = await grantFields(test); await fresh.repository.check(); await fresh.consent.check();
    const review = await test.panel.locator('.connection-consent').innerText();
    for (const token of [test.state.id.a, test.state.id.connection, 'github.get-issue.v1', 'fixture/first', '101']) assert.ok(review.includes(token), 'Consent must display the exact reviewed identity, action, account and resource.');
    // Recipient changes deliberately reset the entire scope; exercised in the next case.
    await waitForMutation(test.page, '/v1/action-grants', () => fresh.submit.click());
    assert.equal(grantPosts(test.state).length, 1);
    const body = grantPosts(test.state)[0].body;
    assert.equal(body.recipientId, test.state.id.a); assert.equal(body.actionId, 'github.get-issue.v1'); assert.equal(body.connectionId, test.state.id.connection);
    assert.deepEqual(body.repositoryIds, ['101']); assert.match(body.expiresAt, /Z$/u);
    await unknownReadiness(test.panel);
  });
  await check('Selecting a different identity clears action, account, resources and approval', {}, async test => {
    await chooseAgent(test); await approveGrant(test);
    step = 'identity switch resets consent';
    await chooseAgent(test, 'b');
    await openSetup(test.panel);
    assert.equal(await visible(test.panel.getByRole('combobox', { name: /^Action$/i })).inputValue(), '');
    assert.equal(await visible(test.panel.getByRole('combobox', { name: /^Connected account$/i })).inputValue(), '');
    assert.equal(await test.panel.getByRole('checkbox', { checked: true }).count(), 0);
    assert.ok(await button(test.panel, labels.grant).isDisabled());
    assert.equal(grantPosts(test.state).length, 0);
  });
  await check('Synchronous duplicate grant submit creates one exact grant', { grantGate: deferred() }, async test => {
    await chooseAgent(test); const fields = await approveGrant(test);
    step = 'duplicate grant in same browser task';
    await fields.submit.evaluate(node => { const form = node.closest('form'); if (!form) throw new Error('No native form'); form.requestSubmit(); form.requestSubmit(); });
    await completed(test.state.grantStarted.promise); assert.equal(grantPosts(test.state).length, 1);
    test.state.grantGate.resolve(); await reconcile(test); assert.equal(grantPosts(test.state).length, 1);
  });
  await check('Ambiguous grant completion requires reconciliation, never blind retry', { grantResponse: 'ambiguous' }, async test => {
    await chooseAgent(test); const fields = await approveGrant(test); await fields.submit.click();
    step = 'uncertain grant completion'; await visible(test.panel.getByRole('alert')).first().waitFor();
    assert.equal(grantPosts(test.state).length, 1); assert.ok(await fields.submit.isDisabled(), 'Uncertain submission must be reconciled before another attempt.');
    await reconcile(test); assert.equal(grantPosts(test.state).length, 1); await unknownReadiness(test.panel);
  });
  for (const timezone of ['America/Los_Angeles', 'Asia/Kolkata']) {
    await check(`Expiry presets and custom local time serialize correctly in ${timezone}`, { timezone }, async test => {
      await createAgent(test); await issueControl(test.panel);
      step = 'native expiry presets';
      const initialExpiry = visible(test.panel.locator('input[type="datetime-local"]')).first();
      assert.equal(await initialExpiry.evaluate(node => new Date(node.value).getTime()), fixedNow.getTime() + 30 * 86400000, 'Default expiry is 30 days in the local timezone.');
      const presets = visible(test.panel.getByRole('combobox')).filter({ has: test.page.locator('option', { hasText: /7 days/i }) }).first();
      const options = await presets.count() ? await presets.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent }))) : [];
      for (const days of [7, 30, 90]) {
        if (options.length) {
          const option = options.find(option => new RegExp(`\\b${days} days\\b`, 'i').test(option.text));
          assert.ok(option, `Expected ${days}-day preset.`); await presets.selectOption(option.value);
        } else await button(test.panel, new RegExp(`^${days} days$`)).click();
        const expiry = visible(test.panel.locator('input[type="datetime-local"]')).first();
        const epoch = await expiry.evaluate(node => new Date(node.value).getTime());
        assert.ok(Math.abs(epoch - fixedNow.getTime() - days * 86400000) < 60000, 'Preset must represent duration, not an incorrectly shifted timezone.');
      }
      if (options.length) { const custom = options.find(option => /custom/i.test(option.text)); assert.ok(custom); await presets.selectOption(custom.value); }
      const expiry = visible(test.panel.locator('input[type="datetime-local"]')).first();
      await expiry.fill('2026-11-01T11:45'); const expected = await expiry.evaluate(node => new Date(node.value).toISOString());
      await issueKey(test); assert.equal(keyPosts(test.state)[0].body.expiresAt, expected); await acknowledge(test);
    });
  }
  await check('Workspace and personal MCP examples use placeholders and distinct exact tools', {}, async test => {
    await chooseAgent(test, 'noKey');
    await openSetup(test.panel);
    step = 'placeholder-only client configuration';
    const details = visible(test.panel.getByRole('button', { name: /Client setup|Connect client|MCP setup|Connection instructions/i }));
    if (await details.count()) await details.first().click();
    const summaries = visible(test.panel.locator('summary'));
    for (const summary of await summaries.all()) if (/client|environment|mcp|connect.*agent/i.test(await summary.innerText())) await summary.click();
    const text = await test.panel.innerText();
    assert.match(text, /CAPYKIT_BASE_URL/u); assert.match(text, /CAPYKIT_API_KEY/u); assert.match(text, /capykit-mcp\s+--remote/u);
    assert.match(text, /(?:YOUR[_ -](?:SAVED[_ -])?(?:AGENT[_ -])?KEY|<[^>]*(?:key|KEY)[^>]*>|\$\{CAPYKIT_API_KEY\})/u);
    assert.doesNotMatch(text, /ck_agent_[A-Za-z0-9_-]{43}/u);
    for (const tool of ['list_actions', 'get_action', 'run_action', 'list_connections', 'list_connection_actions', 'run_connection_action']) assert.ok(text.includes(tool), `Missing exact MCP tool ${tool}.`);
    assert.match(text, /run_action\(\{id: ["']<ACTION_ID>["'], connectionId:/u);
    assert.match(text, /run_connection_action\(\{connectionId: ["']<PERSONAL_CONNECTION_ID>["'], action: ["']<ACTION_NAME>["']/u);
    assert.match(text, /list_connection_actions\(\{connectionId:/u);
    assert.match(text, /personal.{0,100}(?:change|write|mutat)|(?:change|write|mutat).{0,100}personal/isu);
    assert.equal(keyPosts(test.state).length, 0); await unknownReadiness(test.panel);
  });
  await check('App-scoped setup never grants a different integration', { app: 'github' }, async test => {
    await chooseAgent(test); const fields = await grantFields(test);
    const options = await fields.action.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
    assert.ok(options.includes('github.get-issue.v1')); assert.equal(options.includes('drive.get-file.v1'), false);
  });
  await check('App access retains grant metadata after provider availability disappears', { app: 'github' }, async test => {
    await chooseAgent(test); test.state.actions = []; await reconcile(test);
    await openSetup(test.panel);
    for(const card of await test.panel.locator('.agent-access-card > summary').all())await card.click();
    const text = await test.panel.innerText();
    assert.ok(text.includes(test.state.id.ga)); assert.ok(text.includes('Unavailable account'));
    assert.ok(text.includes('No workspace actions available'));
    assert.equal(grantPosts(test.state).length, 0);
    await unknownReadiness(test.panel);
  });
  for (const ambiguous of [false, true]) {
    await check(`Personal-account exact review, duplicate lock and ${ambiguous ? 'uncertain reconciliation' : 'explicit grant'}`, { app: 'github', personal: true, grantResponse: ambiguous ? 'ambiguous' : 'ok', grantGate: deferred(), width: 320 }, async test => {
      const personal = visible(test.page.locator('.personal-app'));
      step = 'review personal action sharing';
      assert.equal(await personal.count(), 1, 'One active personal-account surface');
      await button(personal, /^Share an action$/).click();
      await personal.getByLabel('User or agent', { exact: true }).selectOption(test.state.id.a);
      await personal.getByLabel('Action', { exact: true }).selectOption('getIssueInformation');
      const consent = personal.getByRole('checkbox', { name: /^I approve this exact personal/ });
      const submit = button(personal, /^Share action$/);
      assert.ok(await submit.isDisabled());
      const review = await personal.locator('.connection-consent').innerText();
      for (const token of [test.state.id.a, test.state.id.personal, 'getIssueInformation', 'no per-repository restriction']) assert.ok(review.includes(token));
      await consent.check(); await button(personal, /^7 days$/).click(); assert.equal(await consent.isChecked(), false);
      await consent.check();
      await submit.evaluate(node => { const form = node.closest('form'); form.requestSubmit(); form.requestSubmit(); });
      await completed(test.state.grantStarted.promise); assert.equal(test.state.personalGrants.length, 0);
      test.state.grantGate.resolve();
      if (ambiguous) {
        await personal.getByRole('alert').first().waitFor(); assert.ok(await submit.isDisabled());
        await button(personal, /^Reload sharing$/).click();
        await personal.getByRole('checkbox', { name: /^I approve this exact personal/ }).waitFor();
        assert.equal(test.state.personalGrants.length, 1);
      } else await personal.getByRole('status').filter({ hasText: 'Only the reviewed personal-account action' }).waitFor();
      await personal.locator('summary').filter({ hasText: /^Personal agent client instructions$/ }).click();
      await unknownReadiness(personal);
      assert.ok(await test.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });
  }
  for(const outcome of ['ok','ambiguous','uncommitted']) {
    await check(`Personal pending ${outcome} survives actual All apps navigation before commit`,{app:'github',personal:true,grantGate:deferred(),grantResponse:outcome},async test=>{
      step='pending grant then All apps and reopen';
      const {submit}=await personalReview(test);await submit.click();await completed(test.state.grantStarted.promise);
      const path=`/v1/connections/personal/${test.state.id.personal}/grants`,readPath=`/v1/connections/personal/${test.state.id.personal}/sharing`;
      assert.equal(test.state.personalGrants.length,0);
      const reads=test.state.requests.filter(r=>r.path===readPath).length;
      const personal=await reopenPersonal(test);
      await personal.getByRole('status',{name:/Sharing request pending/}).waitFor();
      await button(personal,/^Share an action$/).click();
      assert.equal(test.state.requests.filter(r=>r.path===readPath).length,reads,'A pre-commit read must not unlock a pending write.');
      assert.equal(await button(personal,/^Share action$/).count(),0);
      assert.equal(mutations(test.state,path).length,1);
      test.state.grantGate.resolve();
      await personal.getByRole('status',{name:/Sharing request pending/}).waitFor({state:'hidden'});
      await button(personal,/^Share an action$/).click();
      await personal.getByLabel('User or agent',{exact:true}).waitFor();
      assert.equal(mutations(test.state,path).length,1);
      if(outcome==='uncommitted'){
        await personal.getByRole('alert').filter({hasText:'Grant outcome unknown'}).waitFor();
        assert.ok(await personal.getByLabel('User or agent',{exact:true}).isDisabled());
        await button(personal,/^Reload sharing$/).click();
        assert.ok(await personal.getByLabel('User or agent',{exact:true}).isDisabled(),'Absence in a read cannot prove an ambiguous write failed.');
        const body=mutations(test.state,path)[0].body;
        test.state.personalGrants.push({id:randomUUID(),...body,revokedAt:null});
        await button(personal,/^Reload sharing$/).click();
      }
      await test.page.waitForFunction(()=>!document.querySelector('.personal-sharing select')?.disabled);
      assert.equal(test.state.personalGrants.length,1);
      assert.equal(mutations(test.state,path).length,1,'Reconciliation never retries the POST.');
      assert.equal(await personal.getByRole('checkbox',{name:/^I approve this exact personal/}).count(),0,'Reopened consent must be reviewed again.');
    });
  }
  await check('Personal pending state is account-scoped, not an app-wide lock',{app:'github',personal:true,multiplePersonal:true,grantGate:deferred()},async test=>{
    const {submit}=await personalReview(test);await submit.click();await completed(test.state.grantStarted.promise);
    const personal=await reopenPersonal(test);
    await personal.getByLabel('Account',{exact:true}).selectOption(test.state.id.otherPersonal);
    const other=await personalReview(test);assert.ok(await other.submit.isEnabled(),'Unrelated accounts must not inherit the pending grant.');
    await personal.getByLabel('Account',{exact:true}).selectOption(test.state.id.personal);
    await personal.getByRole('status',{name:/Sharing request pending/}).waitFor();
    await button(personal,/^Share an action$/).click();
    assert.equal(await button(personal,/^Share action$/).count(),0);
    assert.equal(mutations(test.state,`/v1/connections/personal/${test.state.id.personal}/grants`).length,1);
    test.state.grantGate.resolve();
    await personal.getByRole('status',{name:/Sharing request pending/}).waitFor({state:'hidden'});
  });
  for(const [outcome,message] of [['FORBIDDEN','You no longer have permission'],['CONNECTION_INACTIVE','Refresh and reconnect'],['CSRF_REQUIRED','Reload the page to refresh your session']]){
    await check(`Personal definite ${outcome} preserves actionable denial without uncertainty`,{app:'github',personal:true,grantResponse:outcome},async test=>{
      step='definite sharing denial';
      const {personal,submit}=await personalReview(test);await submit.click();
      await personal.getByRole('alert').filter({hasText:message}).waitFor();
      assert.doesNotMatch(await personal.innerText(),/Grant outcome unknown/);
      assert.equal(test.state.personalGrants.length,0);
      assert.ok(await personal.getByLabel('User or agent',{exact:true}).isEnabled());
      assert.ok(await submit.isDisabled(),'A denial clears consent, not the ability to correct it.');
      test.state.grantResponse='ok';
      await personal.getByRole('checkbox',{name:/^I approve this exact personal/}).check();await submit.click();
      await personal.getByRole('status').filter({hasText:'Only the reviewed personal-account action'}).waitFor();
      assert.equal(test.state.personalGrants.length,1);
    });
  }
  for(const outcome of ['server-error','timeout','malformed']){
    await check(`Personal ambiguous ${outcome} pauses until matching metadata reconciliation`,{app:'github',personal:true,grantResponse:outcome},async test=>{
      step='uncertain sharing response';
      const {personal,submit}=await personalReview(test);await submit.click();
      await personal.getByRole('alert').filter({hasText:'Grant outcome unknown'}).first().waitFor();
      assert.ok(await submit.isDisabled());assert.equal(test.state.personalGrants.length,1);
      await button(personal,/^Reload sharing$/).click();
      await personal.getByRole('status').filter({hasText:'The reviewed grant is recorded'}).waitFor();
      assert.equal(test.state.personalGrants.length,1);
      assert.equal(mutations(test.state,`/v1/connections/personal/${test.state.id.personal}/grants`).length,1);
    });
  }
  await check('Read-only browser owner test is not client readiness evidence', {}, async test => {
    await chooseAgent(test); await unknownReadiness(test.panel);
    await openSetup(test.panel);
    step = 'owner read-only test';
    const summary = visible(test.panel.locator('summary')).filter({ hasText: /^Owner-browser read-only connection test$/i });
    if (await summary.count()) await summary.click();
    else { const testButton = await reach(test.panel, () => button(test.panel, labels.test)); await testButton.first().click(); }
    const ownerConsole = visible(test.page.locator('.connector-actions'));
    const action = button(ownerConsole, /^Get an issue/).first(); await action.waitFor(); await action.click();
    await visible(ownerConsole.getByRole('combobox', { name: /^Connected account$/i })).selectOption(test.state.id.connection);
    await visible(ownerConsole.getByRole('combobox', { name: /^Repository$/i })).selectOption('101');
    await visible(ownerConsole.getByLabel(/^Issue number$/i)).fill('12');
    await button(ownerConsole, /^(Run action|Test connection)$/i).click();
    await test.page.getByText('Fixture owner read-only result', { exact: true }).waitFor();
    assert.equal(test.state.ownerReads, 1); assert.equal(keyPosts(test.state).length, 0); assert.equal(grantPosts(test.state).length, 0);
    await test.page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Agents', exact: true }).click();
    await unknownReadiness(test.panel);
  });
  for (const width of [320, 375, 430, 1440]) {
    await check(`Selected design hierarchy and intact primary navigation at ${width}px`,{width},async test=>{
      await chooseAgent(test,'b');
      assert.equal(await test.panel.locator('.agent-setup').evaluate(node=>node.open),false);
      assert.equal(await test.panel.locator('.agent-history').evaluate(node=>node.open),false);
      assert.equal(await visible(test.panel.getByRole('combobox')).count(),0,'Returning management is not an expanded form stack.');
      const nav=test.page.getByRole('navigation',{name:'Workspace',exact:true});
      assert.deepEqual(await nav.getByRole('button').allTextContents(),['Apps','Agents','Actions']);
      const hierarchy=await test.panel.evaluate(panel=>['.agent-heading','.agent-verification','[aria-label="Allowed workspace access"]','.agent-setup','[aria-label="Agent keys"]','.agent-history'].map(selector=>panel.querySelector(selector).getBoundingClientRect().top));
      assert.ok(hierarchy.every((top,index)=>!index||top>hierarchy[index-1]));
      assert.ok((await test.panel.locator('.agent-metadata').innerText()).includes(test.state.id.b.slice(-8)));
      assert.equal(await test.panel.locator('.agent-verification.astryx-banner').count(),0,'Unverified is neutral information, not a warning.');
      const copy=test.panel.locator('.agent-access-copy');
      assert.match(await copy.innerText(),/GitHub\nGet an issue\nAccount: Fixture GitHub\nRepositories: fixture\/second\nRead only · active\nExpires /u);
      const lines=await copy.locator(':scope > .astryx-text').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect()));
      assert.equal(lines.length,6);
      assert.ok(lines.every((box,index)=>!index||box.top>=lines[index-1].bottom),'Access labels must not merge inline.');
      await copy.locator('..').click();
      const exact=test.panel.locator('.agent-access-card');
      for(const id of [test.state.id.b,test.state.id.gb,test.state.id.connection,'102'])assert.ok((await exact.innerText()).includes(id),'Technical IDs remain discoverable.');
      await copy.locator('..').click();
      const navLines=await nav.locator('button span').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().height<=parseFloat(getComputedStyle(node).lineHeight)+1));
      assert.ok(navLines,'Navigation labels must not wrap, including midword.');
      if(process.env.CAPYKIT_AGENT_VISUAL_DIR){
        assert.equal(test.state.sentinels.length,0,'Never capture a credential reveal.');
        await mkdir(process.env.CAPYKIT_AGENT_VISUAL_DIR,{recursive:true});
        await test.page.screenshot({path:join(process.env.CAPYKIT_AGENT_VISUAL_DIR,`fixture-agent-${width}.png`),fullPage:true});
      }
      await test.page.locator('.workspace-tools > summary').click();
      const tools=test.page.getByRole('navigation',{name:'Workspace tools',exact:true});
      assert.deepEqual(await tools.getByRole('button').allTextContents(),['Functions','People access']);
    });
    await check(`Layout, keyboard focus and touch controls at ${width}px`, { width }, async test => {
      await chooseAgent(test); const fields = await grantFields(test);
      step = 'keyboard repository and consent';
      await fields.repository.focus(); await test.page.keyboard.press('Space'); assert.equal(await fields.repository.isChecked(), true);
      await fields.consent.focus(); await test.page.keyboard.press('Space'); assert.ok(await fields.submit.isEnabled());
      await test.page.keyboard.press('Tab');
      assert.equal(await test.page.evaluate(() => document.activeElement?.tagName === 'BODY'), false, 'Keyboard focus must remain on a real control.');
      step = 'responsive overflow and target geometry';
      const geometry = await test.page.evaluate(() => {
        const controls = [...document.querySelectorAll('button,input,select,summary')].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        return { overflow: document.documentElement.scrollWidth > innerWidth, outside: controls.filter(node => { const box = node.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }).length,
          small: controls.filter(node => { const box = node.getBoundingClientRect(); const label = node.closest('label') ?? node.labels?.[0]; const target = node.matches('input[type="checkbox"],input[type="radio"]') && label ? label.getBoundingClientRect() : box; return target.height < 44 || target.width < 44; }).length };
      });
      assert.deepEqual(geometry, { overflow: false, outside: 0, small: 0 }, JSON.stringify(geometry));
      if (width < 600) {
        await fields.repository.tap(); assert.equal(await fields.repository.isChecked(), false);
        await fields.repository.tap(); await fields.consent.tap();
      }
      const apps = test.page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Apps', exact: true });
      await apps.focus(); await test.page.keyboard.press('Enter'); await test.page.getByRole('heading', { name: 'Apps', exact: true }).waitFor();
      assert.equal(new URL(test.page.url()).searchParams.get('tab'), 'connections');
      await button(test.page, /^GitHub.*Connected/s).first().click();
      await test.page.waitForFunction(() => document.activeElement?.tagName === 'H1' && document.activeElement.textContent === 'GitHub');
    });
  }
}
try {
  await main();
} catch (error) {
  results.push({ name: 'fixture harness startup', passed: false, fixtureOnly: true, step, error: error.code === 'ENOENT' ? 'missing-console-build-use-CAPYKIT_AGENT_SOURCE=1' : 'tool-or-harness-error' });
} finally {
  await browser?.close();
  const passed = results.length > 0 && results.every(result => result.passed);
  const report={...evidenceMetadata,fixtureOnly:true,liveBackendVerified:false,passed,results};
  if(process.env.CAPYKIT_AGENT_VISUAL_DIR&&visualOnly)await writeFile(join(process.env.CAPYKIT_AGENT_VISUAL_DIR,'metadata.json'),JSON.stringify(report,null,2)+'\n');
  if(process.env.CAPYKIT_AGENT_EVIDENCE_FILE)await writeFile(process.env.CAPYKIT_AGENT_EVIDENCE_FILE,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
}
