// ENG-162: isolated built-console fixtures, never a deployed/backend/provider check.
// Reuses the existing external Playwright/Chromium route. No dependency installation.
// CAPYKIT_ADVANCED_BASELINE=1 captures the preceding slice without component assertions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.CAPYKIT_CONSOLE_DIR ?? join(root, 'dist/console'));
const baseline = process.env.CAPYKIT_ADVANCED_BASELINE === '1';
const phase = baseline ? 'before' : 'after';
const evidence = resolve(process.env.CAPYKIT_ADVANCED_EVIDENCE_DIR ?? join(root, 'docs/evidence/ENG-162/advanced', phase));
await mkdir(evidence, { recursive: true });
const origin = 'https://capykit.example.test', csrf = 'fixture-private-csrf-sentinel';
const assets = new Map([['/', await readFile(join(directory, 'index.html'))]]);
for (const name of await readdir(join(directory, 'assets'))) assets.set(`/assets/${name}`, await readFile(join(directory, 'assets', name)));
const buildSha256 = createHash('sha256').update(Buffer.concat([...assets.entries()].sort().flatMap(([name, data]) => [Buffer.from(name), data]))).digest('hex');
const revision = baseline ? '6819c79230221355046261a16bf5e314753eb46e' : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? '/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CAPYKIT_CHROMIUM_PATH ?? '/opt/data/browser-fixtures/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox'] });
const report = { phase, revision, revisionMeaning: 'Repository HEAD; buildSha256 identifies exact served bytes including working-tree changes.', buildSha256, browserVersion: browser.version(), nodeVersion: process.version, implementationModel: 'gpt-6.1-sol', pluginRevision: '08359024b405bf92afc3b4624675415384b67e5a', fixtureOnly: true, backendVerified: false, providerVerified: false, physicalDeviceVerified: false, independentReview: false, results: [], screenshots: [] };
const account = { id: 'connection', name: 'Fixture account', repositories: [{ id: '101', name: 'fixture/first' }, { id: '102', name: 'fixture/second' }] };
const actions = [{ id: 'github.get-issue.v1', app: 'github', name: 'Read fixture issue', description: 'Read-only issue metadata', fields: [{ key: 'issueNumber', name: 'Issue number', description: '', required: true, type: 'number' }], connections: [account] }, { id: 'drive.find-files.v1', app: 'google-drive', name: 'Find fixture files', description: 'Read-only metadata', fields: [{ key: 'name', name: 'Name', description: '', required: true, type: 'text' }], connections: [{ ...account, id: 'drive', repositories: [] }] }];
const capability = { id: 'function', name: 'Fixture function', slug: 'fixture-function', kind: 'function', createdAt: '2026-01-01T00:00:00Z' };
const summary = { digest: `sha256:${'a'.repeat(64)}`, fileCount: 1, byteCount: 64, contract: { operation: 'github.issues.list.v1' }, files: [{ path: 'index.mjs', executable: false, byteLength: 64, sha256: 'a'.repeat(64) }] };
const published = { ...summary, version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z' };
const detail = { ...capability, draft: { ...summary, version: '2.0.0', updatedAt: '2026-01-02T00:00:00Z' }, versions: [published] };
const options = { users: [{ id: 'user', name: 'Alex', email: 'alex@example.test', role: 'member' }], versions: [{ capabilityId: 'function', name: capability.name, kind: 'function', version: '1.0.0', operation: 'github.issues.list.v1' }], connections: [account], truncated: false };
const existingGrant = { id: 'grant', recipientName: 'Alex', capabilityName: capability.name, version: '1.0.0', repositoryIds: ['101'], action: 'invoke', connectionName: account.name, repositories: [account.repositories[0]], expiresAt: '2027-01-01T00:00:00Z', status: 'active' };
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true });
const posts = (state, path) => state.requests.filter(request => request.method === 'POST' && request.path === path);
function gate() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }
async function ready(page, tab) {
  await page.getByRole('heading', { name: tab === 'actions' ? 'Available actions' : tab === 'capabilities' ? 'Functions & skills' : baseline ? 'Access' : 'People access', exact: true }).filter({ visible: true }).waitFor();
}
async function geometry(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document overflow');
  const invalid = await page.locator('button,select,input:not([type=checkbox])').filter({ visible: true }).evaluateAll(nodes => nodes.filter(node => { const box = node.getBoundingClientRect(); return box.width < 44 || box.height < 44 || box.left < -1 || box.right > innerWidth + 1; }).map(node => node.getAttribute('aria-label') || node.textContent || node.id));
  assert.deepEqual(invalid, [], 'Visible controls have in-bounds 44px targets');
  if (!baseline) {
    assert.equal(await page.locator('.legacy-route').count(), 0);
    assert.equal(await page.locator('html').getAttribute('data-astryx-theme'), 'neutral');
    const nativeButtons = await page.locator('button').filter({ visible: true }).evaluateAll(nodes => nodes.filter(node => {
      let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
      for (; fiber; fiber = fiber.return) if (['Button', 'ListItem', 'Table'].includes(fiber.type?.displayName)) return false;
      return true;
    }).map(node => node.textContent));
    assert.deepEqual(nativeButtons, [], 'Controls must mount actual installed Astryx components');
  }
}
async function capture(test, name) {
  const { page, settings } = test;
  assert.equal(await page.locator('#email,#code,input[type=password]').evaluateAll(nodes => nodes.some(node => node.value)), false, 'No filled secret fields in evidence');
  const file = `${name}-${settings.width ?? 375}-${settings.theme ?? 'light'}.png`;
  await page.screenshot({ path: join(evidence, file), fullPage: true });
  report.screenshots.push({ file, route: new URL(page.url()).pathname + new URL(page.url()).search, viewport: page.viewportSize(), theme: settings.theme ?? 'light', media: settings.media ?? 'light', fixtureOnly: true, buildSha256, revision });
}
async function check(name, settings, run) {
  const context = await browser.newContext({ viewport: { width: settings.width ?? 375, height: 900 }, colorScheme: settings.media ?? 'light', serviceWorkers: 'block' });
  await context.addCookies([{ name: 'capykit_csrf', value: csrf, url: origin }]);
  await context.addInitScript(theme => { if (!localStorage.getItem('capykit.appearance')) localStorage.setItem('capykit.appearance', theme); }, settings.theme ?? 'light');
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const state = { capabilities: [capability], detail: structuredClone(detail), grants: [structuredClone(existingGrant)], requests: [], violations: [], ...settings };
  page.on('pageerror', error => state.violations.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    try {
      assert.equal(url.origin, origin, 'Every request stays in intercepted fixture origin');
      assert.equal(Boolean(request.headers().authorization), false);
      if (assets.has(path)) return route.fulfill({ contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/javascript', body: assets.get(path) });
      const entry = { path, method, body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] }; state.requests.push(entry);
      if (!['GET', 'HEAD'].includes(method)) assert.equal(entry.csrf, csrf);
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      if (path === '/v1/auth/method') return json({ method: 'email' });
      if (path === '/v1/me') return json({ identity: { email: 'owner@example.test', principalKind: 'human' }, workspace: { id: 'fixture-workspace', role: state.member ? 'member' : 'owner' } });
      if (path === '/v1/connections') return json({ configured: false, connections: [], setup: null, installationUrl: null });
      if (path === '/v1/apps' || path === '/v1/apps/catalog') return json({ apps: [], github: [], google: { configured: false, connection: null } });
      if (path === '/v1/actions') { if (state.readGate && settings.tab === 'actions') await state.readGate.promise; return state.readError && settings.tab === 'actions' ? json({ error: { code: 'FORBIDDEN' } }, 403) : json({ actions: state.empty ? [] : actions }); }
      if (path.endsWith('/run')) { if (state.runGate) await state.runGate.promise; return state.runError ? json({ error: { code: 'PROVIDER_RESOURCE_NOT_FOUND' } }, 404) : json({ result: path.includes('drive.') ? { files: state.noFiles ? [] : [{ id: 'fixture-file', name: 'Fixture report', mimeType: 'text/plain' }], ...(state.nextPage ? { nextPageToken: 'fixture-next' } : {}) } : { number: 12, title: 'Fixture issue result', state: 'open' } }); }
      if (path === '/v1/capabilities' && method === 'GET') { if (state.readGate && settings.tab === 'capabilities') await state.readGate.promise; return state.readError && settings.tab === 'capabilities' ? json({}, 503) : json({ capabilities: state.empty ? [] : state.capabilities }); }
      if (path === '/v1/capabilities' && method === 'POST') { state.detail = { ...capability, ...entry.body, id: 'new', draft: null, versions: [] }; return json(state.detail, 201); }
      if (/^\/v1\/capabilities\/[^/]+\/draft$/u.test(path)) { state.detail.draft = { ...summary, version: entry.body.version }; return json(state.detail); }
      if (path.endsWith('/publish')) { assert.deepEqual(entry.body, { version: state.detail.draft.version, digest: state.detail.draft.digest }); state.detail.versions.push({ ...state.detail.draft, publishedAt: '2026-01-02T00:00:00Z' }); state.detail.draft = null; return json(state.detail); }
      if (/^\/v1\/capabilities\/[^/]+$/u.test(path)) { if (method === 'DELETE') { if (state.deleteError) return json({}, 503); state.capabilities = []; return route.fulfill({ status: 204 }); } return json(state.detail); }
      if (path === '/v1/access/options') { if (state.readGate && settings.tab === 'access') await state.readGate.promise; return state.readError && settings.tab === 'access' ? json({ error: { code: 'FORBIDDEN' } }, 403) : json(state.empty ? { ...options, versions: [] } : options); }
      if (path === '/v1/grants' && method === 'GET') return json({ grants: state.empty ? [] : state.grants, nextCursor: null });
      if (path === '/v1/grants' && method === 'POST') return json(existingGrant, 201);
      if (path === '/v1/grants/grant' && method === 'DELETE') { if (state.revokeGate) await state.revokeGate.promise; if (state.revokeError) return json({ error: { code: 'FORBIDDEN' } }, 403); state.grants[0].status = 'revoked'; return route.fulfill({ status: 204 }); }
      throw new Error(`Unexpected fixture route ${method} ${path}`);
    } catch (error) { state.violations.push(error.message); await route.abort().catch(() => {}); }
  });
  const test = { page, state, settings };
  try {
    await page.goto(`${origin}/?tab=${settings.tab}&retain=fixture`);
    await ready(page, settings.tab);
    await run(test);
    assert.deepEqual(state.violations, []);
    report.results.push({ name, settings: Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, key.endsWith('Gate') ? 'held-until-assertion' : value])), passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.results.push({ name, passed: false, error: error.message, violations: state.violations, requestPaths: state.requests.map(r => `${r.method} ${r.path}`), openDialogs: await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, buttons: [...node.querySelectorAll('button')].map(button => ({ text: button.textContent, disabled: button.disabled, label: button.getAttribute('aria-label') })) }))), accessibility: await page.locator('body').ariaSnapshot() });
    process.exitCode = 1; console.error(`FAIL ${name}: ${error.message}`);
  } finally { state.readGate?.release(); state.runGate?.release(); state.revokeGate?.release(); await context.close(); }
}
async function issueForm(page) {
  await button(page, /Read fixture issue/).click();
  await page.getByLabel('Connected account', { exact: true }).selectOption('connection');
  await page.getByLabel('Repository', { exact: true }).selectOption('101');
  await page.getByLabel('Issue number', { exact: true }).fill('12');
}
async function peopleChoices(page) {
  await page.getByLabel('User', { exact: true }).selectOption('user');
  await page.getByLabel('Published capability version', { exact: true }).selectOption('function:1.0.0');
  await page.getByLabel('GitHub connection', { exact: true }).selectOption('connection');
  await page.getByRole('checkbox', { name: baseline ? 'fixture/first' : 'fixture/first · 101', exact: true }).check();
}
try {
  for (const width of [320, 375, 430, 1440]) for (const theme of ['light', 'dark']) {
    await check(`Actions list/form ${width} ${theme}`, { tab: 'actions', width, theme }, async test => {
      await button(test.page, /Read fixture issue/).waitFor(); await capture(test, 'actions-list');
      await issueForm(test.page); if (!baseline) await geometry(test.page); await capture(test, 'actions-form');
    });
    await check(`Functions draft/inventory ${width} ${theme}`, { tab: 'capabilities', width, theme }, async test => {
      await button(test.page, /Fixture function/).click(); await button(test.page, 'Publish 2.0.0').waitFor();
      await test.page.locator('summary').filter({ hasText: 'File inventory' }).first().click();
      if (!baseline) await geometry(test.page); await capture(test, 'functions-draft');
    });
    await check(`People exact grant ${width} ${theme}`, { tab: 'access', width, theme }, async test => {
      await peopleChoices(test.page); if (!baseline) await geometry(test.page); await capture(test, 'people-grant');
    });
  }
  if (!baseline) {
    for (const theme of ['light', 'dark']) {
      for (const tab of ['actions', 'capabilities', 'access']) for (const mode of ['loading', 'empty', 'error']) await check(`${tab} ${mode} ${theme}`, { tab, theme, ...(mode === 'loading' ? { readGate: gate() } : mode === 'empty' ? { empty: true } : { readError: true }) }, async test => {
        const { page, state } = test;
        if (mode === 'loading') await page.getByRole('status', { name: /Loading/ }).first().waitFor();
        if (mode === 'empty') await page.getByText(tab === 'actions' ? 'No actions are available.' : tab === 'capabilities' ? 'No capabilities yet' : 'No access grants yet.', { exact: true }).waitFor();
        if (mode === 'error') await page.getByRole('alert').filter({ visible: true }).first().waitFor();
        await geometry(page); await capture(test, `${tab}-${mode}`);
        if (mode === 'loading') { state.readGate.release(); if (tab === 'actions') await button(page, /Read fixture issue/).waitFor(); else if (tab === 'capabilities') await button(page, /Fixture function/).waitFor(); else await page.getByLabel('User', { exact: true }).waitFor(); }
        if (mode === 'error') { state.readError = false; await button(page, tab === 'actions' ? 'Refresh actions' : tab === 'capabilities' ? 'Refresh' : 'Refresh access').click(); if (tab === 'actions') await button(page, /Read fixture issue/).waitFor(); else if (tab === 'capabilities') await button(page, /Fixture function/).waitFor(); else await page.getByLabel('User', { exact: true }).waitFor(); }
      });
      await check(`Action native validation/pending/recovery ${theme}`, { tab: 'actions', theme, runGate: gate() }, async test => {
        const { page, state } = test; await issueForm(page);
        const input = page.getByLabel('Issue number', { exact: true });
        for (const value of ['', '0', '1.5']) { await input.fill(value); await button(page, 'Run action').click(); assert.equal(posts(state, '/v1/actions/github.get-issue.v1/run').length, 0); }
        await input.fill('12'); await input.press('Enter'); await button(page, 'Running…').waitFor();
        assert.ok(await input.isDisabled()); await capture(test, 'actions-pending'); state.runGate.release();
        await page.getByText('Fixture issue result', { exact: true }).waitFor();
        assert.deepEqual(posts(state, '/v1/actions/github.get-issue.v1/run')[0].body, { connectionId: 'connection', input: { repositoryId: '101', issueNumber: 12 } });
        await geometry(page); await capture(test, 'actions-result');
        state.runError = true; await button(page, 'Run action').click(); await page.getByRole('alert').waitFor(); await capture(test, 'actions-provider-error');
        state.runError = false; await button(page, 'Run action').click(); await page.getByText('Fixture issue result', { exact: true }).waitFor();
        await button(page, '← All actions').click(); await button(page, /Find fixture files/).click(); await page.getByLabel('Name contains', { exact: true }).fill('report');
        state.nextPage = true; await button(page, 'Run action').click(); await page.getByRole('link', { name: /Fixture report/ }).waitFor();
        assert.match(await page.getByRole('link', { name: /Fixture report/ }).getAttribute('href'), /\/fixture-file$/);
        state.nextPage = false; state.noFiles = true; await button(page, 'Next 25 results').click(); await page.getByText('No matching files found.', { exact: true }).waitFor();
        assert.deepEqual(posts(state, '/v1/actions/drive.find-files.v1/run')[1].body, { connectionId: 'drive', input: { name: 'report', pageToken: 'fixture-next' } }); await capture(test, 'actions-no-results');
      });
      await check(`Function upload/publish/delete recovery ${theme}`, { tab: 'capabilities', theme }, async test => {
        const { page, state } = test; await button(page, 'New capability').click();
        await page.getByLabel('Name', { exact: true }).fill('Fixture new function'); await page.getByLabel('Identifier', { exact: true }).fill('Bad Identifier');
        await button(page, 'Create capability').click(); assert.equal(posts(state, '/v1/capabilities').length, 0);
        await page.getByLabel('Identifier', { exact: true }).fill('fixture-new'); await page.getByLabel('Kind', { exact: true }).selectOption('function');
        await button(page, 'Create capability').click(); await page.getByRole('heading', { name: 'Upload a draft', exact: true }).waitFor();
        assert.deepEqual(posts(state, '/v1/capabilities')[0].body, { name: 'Fixture new function', slug: 'fixture-new', kind: 'function' });
        const source = Buffer.from('export async function handler() { return { issues: [] }; }');
        await page.getByLabel('Function source', { exact: true }).setInputFiles({ name: 'index.mjs', mimeType: 'text/javascript', buffer: source });
        await page.getByRole('heading', { name: '1 files selected', exact: true }).waitFor();
        const executable = page.getByRole('checkbox', { name: 'Executable: index.mjs', exact: true }); await executable.focus(); await page.keyboard.press('Space'); assert.ok(await executable.isChecked());
        await geometry(page); await capture(test, 'functions-upload'); await button(page, 'Save and validate draft').click(); await button(page, 'Publish 1.0.0').waitFor();
        const upload = state.requests.find(r => r.method === 'PUT' && r.path.endsWith('/draft')).body;
        assert.deepEqual(upload, { version: '1.0.0', artifact: { files: [{ path: 'index.mjs', contentBase64: source.toString('base64'), executable: true, type: 'file' }] } });
        await button(page, 'Publish 1.0.0').click(); await page.getByRole('status').filter({ hasText: 'Version 1.0.0 published' }).waitFor();
        assert.deepEqual(posts(state, '/v1/capabilities/new/publish')[0].body, { version: '1.0.0', digest: summary.digest }); assert.equal(await button(page, 'Publish 1.0.0').count(), 0);
        await button(page, 'Delete capability').click(); const dialog = page.getByRole('dialog'); await dialog.waitFor();
        await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(state.requests.filter(r => r.method === 'DELETE').length, 0);
        await button(page, 'Delete capability').click(); state.deleteError = true; await button(dialog, 'Delete capability and versions').click(); await dialog.getByRole('alert').waitFor();
        await capture(test, 'functions-delete-error'); state.deleteError = false; await button(dialog, 'Keep capability').click();
        const imported = { format: 'capykit.artifact.v1', version: '3.0.0', artifact: { kind: 'function', files: [{ path: 'index.mjs', contentBase64: source.toString('base64'), executable: true, type: 'file' }] } };
        await page.getByLabel('Or import a Capykit download', { exact: true }).setInputFiles({ name: 'fixture.capykit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
        await page.getByRole('heading', { name: '1 files selected', exact: true }).waitFor(); assert.equal(await page.getByLabel('Version', { exact: true }).inputValue(), '3.0.0'); assert.ok(await executable.isChecked());
        const writes = state.requests.filter(r => r.method === 'PUT').length;
        await page.getByLabel('Or import a Capykit download', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...imported, artifact: { ...imported.artifact, files: [{ ...imported.artifact.files[0], path: '../index.mjs' }] } })) });
        await page.getByRole('alert').filter({ hasText: 'A function must contain only index.mjs.' }).waitFor(); assert.equal(state.requests.filter(r => r.method === 'PUT').length, writes);
      });
      await check(`People confirmation keyboard/error/pending recovery ${theme}`, { tab: 'access', theme, revokeError: true }, async test => {
        const { page, state } = test; await button(page, 'Revoke access for Alex').click(); const dialog = page.locator('dialog[open]'); await dialog.waitFor();
        await page.waitForFunction(() => document.activeElement?.textContent === 'Keep access');
        assert.ok(await dialog.evaluate(node => node.matches(':modal')), 'Installed Dialog uses native modal semantics');
        await button(page, 'Refresh access').evaluate(node => node.focus());
        assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)), 'Background controls are inert');
        // Native modal Tab may visit browser chrome (document.body), never background controls.
        for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); assert.ok(await dialog.evaluate(node => node.contains(document.activeElement) || document.activeElement === document.body)); }
        await capture(test, 'people-revoke-dialog'); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
        assert.equal(state.requests.filter(r => r.method === 'DELETE').length, 0); await button(page, 'Revoke access for Alex').click(); await button(dialog, 'Confirm revoke').click();
        await dialog.getByRole('alert').waitFor(); await capture(test, 'people-revoke-error'); await button(dialog, 'Keep access').click();
        state.revokeError = false; state.revokeGate = gate(); await button(page, 'Revoke access for Alex').click(); await button(dialog, 'Confirm revoke').click(); await button(dialog, 'Revoking…').waitFor();
        assert.equal(await dialog.getAttribute('role'), 'alertdialog', 'Required pending confirmation retains its documented alertdialog role');
        assert.ok(await button(dialog, 'Keep access').isDisabled()); await page.keyboard.press('Escape'); assert.ok(await dialog.isVisible());
        state.revokeGate.release(); await dialog.waitFor({ state: 'hidden' }); await page.getByRole('status').filter({ hasText: 'Access revoked' }).waitFor();
        await page.waitForFunction(() => document.activeElement?.textContent === 'Refresh access');
      });
    }
    await check('System appearance and account details retained across direct routes', { tab: 'actions', theme: 'system', media: 'dark' }, async test => {
      const { page } = test; await button(page, /Read fixture issue/).waitFor(); assert.equal(await page.locator('html').getAttribute('data-theme'), null);
      await capture(test, 'system-dark'); await page.emulateMedia({ colorScheme: 'light' }); test.settings.media = 'light'; await capture(test, 'system-light');
      await page.getByLabel('Appearance', { exact: true }).selectOption('dark'); await page.reload(); await ready(page, 'actions');
      assert.equal(await page.getByLabel('Appearance', { exact: true }).inputValue(), 'dark');
      test.settings.theme = 'dark';
      await page.locator('.workspace-details > summary').click(); await page.getByText('fixture-workspace', { exact: true }).waitFor(); await capture(test, 'account-settings');
      assert.equal(new URL(page.url()).searchParams.get('retain'), 'fixture');
    });
  }
} finally {
  report.passed = report.results.every(result => result.passed);
  await writeFile(join(evidence, 'metadata.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.results.length, screenshots: report.screenshots.length, buildSha256 }));
}
