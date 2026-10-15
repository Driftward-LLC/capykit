// ENG-160 isolated built-console browser fixtures. No live API/provider calls or real credentials.
// CAPYKIT_SHELL_BASELINE=1 captures BEFORE; default mode verifies Astryx and captures AFTER.
// Uses an existing external Playwright/Chromium installation; never installs dependencies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://capykit.example.test';
const baseline = process.env.CAPYKIT_SHELL_BASELINE === '1';
const contrastOnly = process.env.CAPYKIT_SHELL_CONTRAST_ONLY === '1';
const phase = baseline ? 'before' : contrastOnly ? 'contrast-repair' : 'after';
const evidence = resolve(process.env.CAPYKIT_SHELL_EVIDENCE_DIR ?? join(root, baseline||contrastOnly?'docs/evidence/ENG-160':'docs/evidence/ENG-161/shell', phase));
const directory = resolve(process.env.CAPYKIT_CONSOLE_DIR ?? join(root, 'dist/console'));
const privateCsrf = 'fixture-private-csrf-sentinel', publicCsrf = 'fixture-public-csrf-sentinel';
const results = [], screenshots = [];
const fixtureMetadata = settings => Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, key.endsWith('Gate') ? 'held-until-assertion' : value]));
const files = new Map();
const html = await readFile(join(directory, 'index.html'));
files.set('/', html);
for (const match of html.toString().matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/gu)) files.set(match[1], await readFile(join(directory, match[1])));
// Keep bootstrap hash stable for BEFORE; fonts are also same-origin AFTER assets.
if (!baseline) {
  for (const name of await readdir(join(directory, 'assets'))) files.set(`/assets/${name}`, await readFile(join(directory, 'assets', name)));
}
const buildSha256 = createHash('sha256').update(Buffer.concat([...files.entries()].sort().flatMap(([name, data]) => [Buffer.from(name), data]))).digest('hex');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const metadata = { phase, revision, revisionMeaning: 'Repository HEAD; build SHA identifies exact built bytes including uncommitted source', disabledChecks: baseline ? ['mounted Astryx identity', 'Neutral appearance and pre-React bootstrap'] : [], buildSha256, capturedAt: new Date().toISOString(), fixtureOnly: true, liveApiVerified: false, providerVerified: false, physicalDeviceVerified: false, independentReview: false, pluginRevision: '08359024b405bf92afc3b4624675415384b67e5a', assets: [...files.keys()], results, screenshots };
// Reject a rebuild before touching saved BEFORE evidence.
if (baseline) {
  assert.equal(revision, '71b392fd43b10d8ba6a8f4244fd1b628abda6ae7');
  assert.equal(buildSha256, '0665ec3da3393ad936a29954fd8b45681519a90ec606293dd91a908bd20b6cc0', 'The baseline build changed; preserve existing BEFORE evidence.');
}
await mkdir(evidence, { recursive: true });
const { chromium } = await import(process.env.CAPYKIT_PLAYWRIGHT_MODULE ?? '/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CAPYKIT_CHROMIUM_PATH ?? '/opt/data/browser-fixtures/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox'] });
metadata.browserVersion = browser.version();
metadata.fixtureDefaults = { origin, signedIn: true, method: 'email', role: 'owner', kind: 'human', media: 'light', sentinelCookiesOnly: true, cookieNames: ['capykit_csrf', 'capykit_public_csrf'] };
const button = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true });
const posts = (state, path) => state.requests.filter(r => r.method === 'POST' && r.path === path);
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function screenshot(test, name) {
  // Only fake account metadata is visible. Never screenshot a filled email/OTP field.
  assert.equal(await test.page.locator('#email,#code').evaluateAll(nodes => nodes.some(node => node.value)), false, 'Screenshots must not retain filled authentication fields.');
  const filename = `${name}.png`;
  await test.page.screenshot({ path: join(evidence, filename), fullPage: true });
  const rendered = await test.page.evaluate(() => ({ themeName: document.documentElement.getAttribute('data-astryx-theme'), mode: document.documentElement.getAttribute('data-theme'), bodyBackground: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color }));
  screenshots.push({ file: filename, route: new URL(test.page.url()).pathname + new URL(test.page.url()).search, viewport: test.page.viewportSize(), theme: baseline ? 'legacy-fixed-dark' : test.settings.theme ?? 'system', mediaPreference: test.settings.media ?? 'light', rendered, fixture: fixtureMetadata(test.settings), buildSha256, revision });
}
async function check(name, settings, run) {
  const state = { signedIn: true, method: 'email', available: true, role: 'owner', kind: 'human', meStatus: 200, logoutStatus: 200, googleStatus: 200, tailscaleStatus: 401, appsStatus: 200, verifyStatus: 200, requests: [], violations: [], ...settings };
  const context = await browser.newContext({ viewport: { width: settings.width ?? 1440, height: 900 }, hasTouch: (settings.width ?? 1440) < 600, colorScheme: settings.media ?? 'light', serviceWorkers: 'block', acceptDownloads: false });
  await context.addCookies([{ name: 'capykit_csrf', value: privateCsrf, url: origin }, { name: 'capykit_public_csrf', value: publicCsrf, url: origin }]);
  if (settings.theme || settings.blockStorage) await context.addInitScript(({ theme, blocked }) => {
    if (theme) localStorage.setItem('capykit.appearance', theme);
    if (blocked) Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new DOMException('Fixture localStorage denied', 'SecurityError'); } });
  }, { theme: settings.theme, blocked: settings.blockStorage });
  const page = await context.newPage();
  await context.addInitScript(() => {
    window.__fixtureCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__fixtureCspViolations.push(event.violatedDirective));
  });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => state.violations.push(`pageerror: ${error.message}`));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    try {
      // A synthetic OAuth page only; this route is never forwarded to Google.
      if (state.oauthFixture && url.href === 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture') return route.fulfill({ contentType: 'text/html', body: '<h1>Google fixture</h1>' });
      assert.equal(url.origin, origin, 'External traffic forbidden (including real OAuth navigation).');
      assert.equal(Boolean(request.headers().authorization), false, 'No bearer credentials allowed.');
      const method = request.method();
      const entry = { path, method, csrf: request.headers()['x-csrf-token'] };
      state.requests.push(entry);
      if (!['GET', 'HEAD'].includes(method)) assert.equal(entry.csrf, state.method === 'google' ? publicCsrf : privateCsrf, 'Every mutation must use the correct sentinel CSRF cookie.');
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      if (files.has(path)) {
        if (path.startsWith('/assets/') && path.endsWith('.js') && path !== '/assets/theme-bootstrap.js' && state.scriptGate) await state.scriptGate.promise;
        return route.fulfill({ headers: path === '/' ? { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.activepieces.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } : {}, contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/javascript', body: files.get(path) });
      }
      if (path === '/v1/auth/method') { if (state.methodGate) await state.methodGate.promise; return json({ method: state.method, available: state.available }); }
      if (path === '/v1/me') {
        if (state.meGate) await state.meGate.promise;
        if (state.meStatus !== 200) return json({ error: { code: state.meStatus === 401 ? 'AUTHENTICATION_REQUIRED' : 'FIXTURE_UNAVAILABLE' } }, state.meStatus);
        return state.signedIn ? json({ identity: { email: 'owner@example.test', principalKind: state.kind }, workspace: { id: 'fixture-workspace', role: state.role } }) : json({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401);
      }
      if (path === '/v1/auth/refresh') return json({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401);
      if (path === '/v1/auth/otp') { assert.equal(method, 'POST'); assert.deepEqual(request.postDataJSON(), { email: 'fixture@example.test' }); if (state.otpGate) await state.otpGate.promise; return json({ status: 'sent' }); }
      if (path === '/v1/auth/verify') { assert.equal(method, 'POST'); assert.deepEqual(request.postDataJSON(), { email: 'fixture@example.test', token: '123456' }); if (state.verifyStatus === 200) state.signedIn = true; return json(state.verifyStatus === 200 ? { status: 'authenticated' } : { error: { code: 'INVALID_CODE' } }, state.verifyStatus); }
      if (path === '/v1/auth/google/start') return state.oauthFixture ? json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' }) : json({ error: { code: 'AUTH_UNAVAILABLE' } }, state.googleStatus);
      if (path === '/v1/auth/tailscale') { if (state.tailscaleStatus === 200) state.signedIn = true; return json({ status: state.tailscaleStatus === 200 ? 'authenticated' : 'denied' }, state.tailscaleStatus); }
      if (path === '/v1/auth/logout') { if (state.logoutStatus === 200) state.signedIn = false; return json({ status: state.logoutStatus === 200 ? 'signed_out' : 'unavailable' }, state.logoutStatus); }
      if (path === '/v1/apps' || path === '/v1/apps/catalog') {
        if (state.appsGate) await state.appsGate.promise;
        if (state.appsStatus !== 200) return json({ error: { code: state.appsStatus === 401 ? 'AUTHENTICATION_REQUIRED' : 'FIXTURE_UNAVAILABLE' } }, state.appsStatus);
        return json({ apps: state.empty ? [] : [{ id: 'github', name: 'GitHub', configured: true, connected: false, supportedInCapykit: true, categories: [], actionCount: 1, triggerCount: 0, description: 'Read-only issue metadata.' }, { id: 'google-drive', name: 'Google Drive', configured: Boolean(state.connectedDrive), connected: Boolean(state.connectedDrive), supportedInCapykit: true, categories: [], actionCount: 1, triggerCount: 0, description: 'Read-only file metadata.' }], github: [], google: { configured: Boolean(state.connectedDrive), connection: state.connectedDrive ? { status: 'active', email: 'fixture@example.test' } : null }, personalEnabled: false });
      }
      if (path === '/v1/capabilities') return json({ capabilities: [] });
      if (path === '/v1/access/options') return json({ users: [], connections: [], versions: [], truncated: false });
      if (path === '/v1/grants') return json({ grants: [], nextCursor: null });
      if (path === '/v1/actions') return json({ actions: [] });
      if (path === '/v1/action-access') return json({ recipients: [], keys: [], grants: [], actions: [] });
      if (path === '/v1/connections') return json({ configured: false, setup: null, connections: [], installationUrl: null });
      throw new Error(`Unexpected fixture route: ${method} ${path}`);
    } catch (error) { state.violations.push(error.message); await route.abort().catch(() => {}); }
  });
  const test = { page, context, state, settings };
  try {
    await page.goto(origin + (settings.route ?? '/?tab=connections'), { waitUntil: settings.scriptGate ? 'commit' : 'load' });
    await run(test);
    assert.deepEqual(await page.evaluate(() => window.__fixtureCspViolations), [], 'Hosted CSP must not block bootstrap, components, or self-hosted fonts.');
    assert.deepEqual(state.violations, [], 'Runtime/network violations');
    results.push({ name, passed: true, fixture: fixtureMetadata(settings), ...(state.contrast ? { contrast: state.contrast } : {}), requestPaths: state.requests.map(r => `${r.method} ${r.path}`) });
  } catch (error) {
    // Fixtures have only sentinel identities. Keep errors concise; no DOM/trace/raw body capture.
    results.push({ name, passed: false, fixture: fixtureMetadata(settings), error: error.message.split('\n')[0], violations: state.violations, requestPaths: state.requests.map(r => `${r.method} ${r.path}`) });
  } finally {
    for (const key of ['methodGate', 'meGate', 'otpGate', 'appsGate', 'scriptGate']) state[key]?.release();
    await context.close();
  }
}
async function appsReady(page) { await page.getByRole('heading', { name: 'Apps', exact: true }).waitFor(); await page.getByRole('status').filter({ hasText: /matching integrations/ }).waitFor(); }
async function signInReady(page) { await page.getByLabel('Invited email address', { exact: true }).waitFor(); await page.waitForFunction(() => !document.getElementById('email')?.disabled); }
async function noOverflow(page) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow'); }
async function astryxButton(control) {
  if (baseline) return;
  assert.ok(await control.evaluate(node => {
    if (!node.classList.contains('astryx-button')) return false;
    let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))];
    for (; fiber; fiber = fiber.return) if (fiber.type?.displayName === 'Button') return true;
    return false;
  }), 'Control must be a mounted installed Astryx Button, not a CSS-only imitation.');
}
async function activate(page, control, key = 'Enter') {
  await control.focus();
  assert.ok(await control.evaluate(node => document.activeElement === node), 'Keyboard focus reaches the actual control.');
  await page.keyboard.press(key);
}
async function tabTo(page, control) {
  for (let count = 0; count < 60; count++) {
    await page.keyboard.press('Tab');
    if (await control.evaluate(node => document.activeElement === node)) return;
  }
  assert.fail('Control is not reachable in the native Tab sequence.');
}
async function themeReady(page, mode) {
  if (baseline) return;
  await page.waitForFunction(() => document.documentElement.getAttribute('data-astryx-theme') === 'neutral');
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Figtree' && font.status === 'loaded')), 'Actual self-hosted Figtree must load, not a fallback font.');
  assert.equal(await page.getByRole('combobox', { name: 'Appearance', exact: true }).inputValue(), mode);
  assert.equal(await page.locator('html').getAttribute('data-theme'), mode === 'system' ? null : mode);
  const brightness = await page.evaluate(() => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return (r + g + b) / (3 * 255);
  });
  const effective = mode === 'system' ? await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  assert.ok(effective === 'dark' ? brightness < 0.3 : brightness > 0.7, 'Rendered body palette must follow the effective mode.');
}
async function shellGeometry(page) {
  await noOverflow(page);
  const invalid = await page.locator('.app-header button,.app-header select,.workspace-nav button,.sign-in button,.sign-in input').filter({ visible: true }).evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label') || node.textContent || node.id, box: node.getBoundingClientRect() })).filter(({ box }) => box.width < 44 || box.height < 44 || box.left < -1 || box.right > innerWidth + 1).map(({ label }) => label.trim()));
  assert.deepEqual(invalid, [], 'Shell controls must be in-bounds with at least 44px targets.');
}
async function destructiveContrastChecks() {
  for (const theme of ['light', 'dark']) await check(`Enabled destructive confirmation contrast ${theme}`, { theme, connectedDrive: true, width: 375 }, async test => {
    const { page, state } = test;
    await appsReady(page); await themeReady(page, theme);
    await page.locator('.app-row').filter({ hasText: 'Google Drive' }).click();
    await page.getByRole('heading', { name: 'Connected account', exact: true }).waitFor();
    await activate(page, button(page, 'Disconnect'));
    const confirm = button(page, 'Confirm disconnect');
    await confirm.waitFor(); assert.ok(await confirm.isEnabled());
    await astryxButton(confirm);
    assert.equal(await confirm.evaluate(node => node.closest('.legacy-route') !== null), false, 'Migrated confirmation must not use legacy control styling.');
    state.contrast = await confirm.evaluate(node => {
      const style = getComputedStyle(node), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const over = (front, back) => front.slice(0,3).map((value,index)=>value*front[3]/255+back[index]*(1-front[3]/255));
      // Neutral destructive surfaces can be translucent. Measure their rendered composite,
      // including the opaque dialog surface, rather than pretending alpha is always 1.
      const ancestors=[];for(let element=node;element;element=element.parentElement)ancestors.unshift(element);
      let backgroundRgb=[255,255,255];for(const element of ancestors)backgroundRgb=over(rgba(getComputedStyle(element).backgroundColor),backgroundRgb);
      const luminance = rgb => {
        const linear = rgb.map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const foreground = luminance(over(rgba(style.color),backgroundRgb)), background = luminance(backgroundRgb);
      return { foreground: style.color, background: style.backgroundColor, compositedBackgroundRgb:backgroundRgb, fontSize: style.fontSize, opacity: style.opacity, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
    });
    assert.equal(state.contrast.opacity, '1');
    assert.ok(state.contrast.ratio >= 4.5, `Enabled destructive text contrast must be >=4.5:1; measured ${state.contrast.ratio}:1 in ${theme}.`);
    await noOverflow(page); await screenshot(test, `google-drive-confirm-disconnect-${theme}`);
    await activate(page, button(page, 'Keep connected'));
    assert.equal(await confirm.count(), 0);
    assert.ok(state.requests.every(request => ['GET', 'HEAD'].includes(request.method)), 'Opening/cancelling confirmation must not submit a destructive action.');
  });
}
async function functionalChecks() {
  for (const theme of ['light', 'dark']) await check(`Public Google initiation ${theme} (provider page fixture only)`, { signedIn: false, method: 'google', oauthFixture: true, route: '/', theme, width: 375 }, async test => {
    const google = button(test.page, 'Continue with Google'); await google.waitFor();
    await astryxButton(google); await screenshot(test, `google-sign-in-${theme}`);
    await activate(test.page, google); await test.page.waitForURL('https://accounts.google.com/**');
    await test.page.getByRole('heading', { name: 'Google fixture', exact: true }).waitFor();
    assert.equal(posts(test.state, '/v1/auth/google/start').length, 1);
  });
  for (const auth of ['google-cancelled', 'google-expired', 'google-failed']) await check(`Google callback ${auth} preserves retry and removes callback query`, { signedIn: false, method: 'google', route: `/?auth=${auth}` }, async ({ page }) => {
    await page.getByRole('alert').filter({ hasText: /Google sign-in|sign-in attempt/ }).waitFor();
    assert.equal(new URL(page.url()).searchParams.has('auth'), false);
    assert.ok(await button(page, 'Continue with Google').isEnabled());
    assert.equal(await page.locator('#email,#code').count(), 0);
  });
  await check('Email callback error removes error/hash and preserves code retry', { signedIn: false, route: '/?error=access_denied#error=fixture' }, async ({ page }) => {
    await signInReady(page);
    await page.getByRole('alert').filter({ hasText: 'That sign-in link expired or could not be verified' }).waitFor();
    assert.equal(new URL(page.url()).search, ''); assert.equal(new URL(page.url()).hash, '');
    assert.ok(await button(page, 'Send sign-in code').isEnabled());
  });
  for (const width of [320, 375, 430, 1440]) {
    await check(`Keyboard navigation and preserved URLs ${width}`, { width, route: '/?tab=connections&retain=fixture' }, async ({ page }) => {
      await appsReady(page);
      const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
      assert.deepEqual((await nav.getByRole('button').allTextContents()).map(text => text.trim()), ['Apps', 'Agents', 'Actions']);
      await tabTo(page, button(nav, 'Apps'));
      if (!baseline) assert.ok(await button(nav, 'Apps').evaluate(node => getComputedStyle(node).outlineStyle !== 'none' && parseFloat(getComputedStyle(node).outlineWidth) > 0), 'Native keyboard focus must have a visible ring.');
      for (const [label, tab, heading] of [['Agents', 'agents', 'Agents'], ['Actions', 'actions', 'Available actions'], ['Apps', 'connections', 'Apps']]) {
        const control = button(nav, label); await astryxButton(control); await activate(page, control, label === 'Actions' ? 'Space' : 'Enter');
        await page.getByRole('heading', { name: heading, exact: true }).filter({ visible: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('tab'), tab);
        assert.equal(new URL(page.url()).searchParams.get('retain'), 'fixture');
        assert.equal(await control.getAttribute('aria-current'), 'page');
      }
      const summary = page.locator('.workspace-tools > summary');
      assert.equal(await summary.innerText(), 'Functions & people access');
      assert.equal(await summary.locator('..').evaluate(node => node.open), false);
      await activate(page, summary, 'Space');
      await tabTo(page, button(page.getByRole('navigation', { name: 'Workspace tools', exact: true }), 'Functions'));
      const tools = page.getByRole('navigation', { name: 'Workspace tools', exact: true });
      for (const [label, tab, heading] of [['Functions', 'capabilities', 'Functions & skills'], ['People access', 'access', baseline ? 'Access' : 'People access']]) {
        const control = button(tools, label); await astryxButton(control); await activate(page, control);
        await page.getByRole('heading', { name: heading, exact: true }).filter({ visible: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('tab'), tab);
        assert.equal(new URL(page.url()).searchParams.get('retain'), 'fixture');
        await noOverflow(page);
      }
      await activate(page, button(nav, 'Apps'));
      await appsReady(page);
      const create = button(page, baseline ? '＋ Create a function' : 'Create a function');
      await astryxButton(create); await activate(page, create);
      await page.getByRole('heading', { name: 'Create a capability', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('tab'), 'capabilities');
      if (width < 641) await page.setViewportSize({ width, height: 420 });
      const name = page.getByLabel('Name', { exact: true });
      await name.focus(); await name.scrollIntoViewIfNeeded();
      assert.ok(await name.evaluate(node => {
        const box = node.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === node;
      }), 'Focused create form remains unobscured by mobile navigation in a short viewport.');
      await noOverflow(page);
    });
  }
  await check('Native email/OTP validity, Astryx keyboard submit and pending disabled behavior', { signedIn: false, route: '/', otpGate: gate(), verifyStatus: 401 }, async ({ page, state }) => {
    await signInReady(page);
    const email = page.getByLabel('Invited email address', { exact: true }), send = button(page, 'Send sign-in code');
    assert.equal(await email.getAttribute('id'), 'email'); assert.equal(await email.getAttribute('type'), 'email');
    assert.equal(await send.getAttribute('type'), 'submit'); await astryxButton(send);
    for (const value of ['', 'not-an-email']) {
      await email.fill(value); await activate(page, send);
      assert.equal(await email.evaluate(node => node.checkValidity()), false);
      assert.equal(posts(state, '/v1/auth/otp').length, 0, 'Native invalid email must not send a request.');
    }
    await email.fill('fixture@example.test');
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/v1/auth/otp');
    await activate(page, send); await requested;
    const pending = page.locator('.sign-in form button').first();
    await page.waitForFunction(() => document.querySelector('.sign-in form button')?.disabled);
    assert.ok(await pending.isDisabled()); assert.ok(await email.isDisabled()); await astryxButton(pending);
    await pending.evaluate(node => node.click()); await page.keyboard.press('Enter');
    assert.equal(posts(state, '/v1/auth/otp').length, 1, 'Disabled Astryx submit must not activate again.');
    state.otpGate.release();
    const code = page.getByLabel('Six-digit sign-in code', { exact: true }); await code.waitFor();
    assert.equal(await code.getAttribute('id'), 'code'); assert.equal(await code.getAttribute('pattern'), '[0-9]{6}');
    assert.equal(await code.getAttribute('autocomplete'), 'one-time-code'); assert.equal(await code.getAttribute('inputmode'), 'numeric');
    const verify = button(page, 'Sign in'); await astryxButton(verify); assert.equal(await verify.getAttribute('type'), 'submit');
    await code.fill('12'); await activate(page, verify); assert.equal(posts(state, '/v1/auth/verify').length, 0);
    await code.fill('123456'); await activate(page, verify);
    await page.getByRole('alert').filter({ hasText: 'That code is invalid or expired' }).waitFor();
    assert.equal(posts(state, '/v1/auth/verify').length, 1); assert.ok(await verify.isEnabled());
    state.verifyStatus = 200; await activate(page, verify, 'Space'); await appsReady(page);
    assert.equal(posts(state, '/v1/auth/verify').length, 2); assert.equal(await page.locator('#code').count(), 0);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('123456')) || Object.values(sessionStorage).some(value => value.includes('123456'))), false, 'OTP must not be persisted.');
  });
  await check('Google available and start failure stays actionable', { signedIn: false, method: 'google', googleStatus: 503, route: '/' }, async test => {
    const { page, state } = test, google = button(page, 'Continue with Google'); await google.waitFor();
    assert.equal(await page.locator('#email,#code').count(), 0); assert.equal(await button(page, 'Continue with Tailscale').count(), 0);
    await astryxButton(google); await activate(page, google);
    await page.getByRole('alert').filter({ hasText: 'Google sign-in is temporarily unavailable' }).waitFor();
    assert.ok(await google.isEnabled()); assert.equal(posts(state, '/v1/auth/google/start').length, 1);
    await screenshot(test, 'google-start-error');
    const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/auth/google/start');
    await activate(page, google, 'Space'); await retried;
    assert.equal(posts(state, '/v1/auth/google/start').length, 2);
  });
  await check('Google unavailable and retry restores available method', { signedIn: false, method: 'google', available: false, route: '/', width: 375 }, async test => {
    const { page, state } = test; const retry = button(page, 'Try again'); await retry.waitFor();
    assert.equal(await button(page, 'Continue with Google').count(), 0); assert.equal(await page.locator('#email,#code').count(), 0);
    await screenshot(test, 'google-unavailable'); state.available = true; await astryxButton(retry); await activate(page, retry, 'Space');
    await button(page, 'Continue with Google').waitFor();
  });
  await check('Tailscale denial and keyboard retry', { signedIn: false, method: 'tailscale', route: '/', width: 375 }, async test => {
    const { page, state } = test; const retry = button(page, 'Continue with Tailscale'); await retry.waitFor();
    await page.getByRole('alert').filter({ hasText: 'Tailscale identity' }).waitFor();
    assert.equal(await page.locator('#email,#code').count(), 0); assert.equal(posts(state, '/v1/auth/tailscale').length, 1);
    await screenshot(test, 'tailscale-denied'); state.tailscaleStatus = 200; await astryxButton(retry); await activate(page, retry);
    await appsReady(page); assert.equal(posts(state, '/v1/auth/tailscale').length, 2);
  });
  await check('Session unavailable and real retry', { meStatus: 503, width: 375 }, async test => {
    const { page, state } = test; await page.getByRole('alert').filter({ hasText: 'Could not check your session' }).waitFor();
    const retry = button(page, 'Retry session check'); await retry.waitFor(); await screenshot(test, 'session-unavailable');
    state.meStatus = 200; await astryxButton(retry); await activate(page, retry); await appsReady(page);
  });
  await check('401 expiry on focus clears owner UI without changing route', { route: '/?tab=connections&retain=fixture' }, async test => {
    const { page, state } = test; await appsReady(page); state.signedIn = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await signInReady(page);
    await page.getByRole('status').filter({ hasText: 'Your session expired or access is no longer available' }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Workspace', exact: true }).count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('retain'), 'fixture');
    await screenshot(test, 'session-expired');
  });
  await check('401 application response clears authenticated shell', {}, async test => {
    const { page, state } = test; await appsReady(page); state.appsStatus = 401; await button(page, 'Refresh apps').click();
    await signInReady(page); assert.equal(await button(page, 'Sign out').count(), 0);
  });
  await check('Logout failure preserves account and success clears account', { logoutStatus: 503, width: 375 }, async test => {
    const { page, state } = test; await appsReady(page); const logout = button(page, 'Sign out'); await astryxButton(logout); await activate(page, logout);
    await page.getByRole('alert').filter({ hasText: 'Could not sign out' }).waitFor();
    assert.ok(await logout.isEnabled()); assert.equal(await page.getByRole('navigation', { name: 'Workspace', exact: true }).count(), 1);
    await screenshot(test, 'logout-error'); state.logoutStatus = 200; await activate(page, logout, 'Space'); await signInReady(page);
    assert.equal(posts(state, '/v1/auth/logout').length, 2); assert.equal(await button(page, 'Sign out').count(), 0);
    await screenshot(test, 'signed-out');
  });
  for (const role of ['owner', 'member']) await check(`Visibility for human ${role}`, { role }, async ({ page, state }) => {
    await appsReady(page);
    const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
    assert.deepEqual((await nav.getByRole('button').allTextContents()).map(text => text.trim()), role === 'owner' ? ['Apps', 'Agents', 'Actions'] : ['Apps', 'Actions']);
    await page.locator('.workspace-tools > summary').click();
    const tools = page.getByRole('navigation', { name: 'Workspace tools', exact: true });
    assert.deepEqual((await tools.getByRole('button').allTextContents()).map(text => text.trim()), role === 'owner' ? ['Functions', 'People access'] : ['Functions']);
    assert.equal(await button(page, baseline ? '＋ Create a function' : 'Create a function').count(), role === 'owner' ? 1 : 0);
    if (!baseline && role === 'owner') await astryxButton(button(page, 'Create a function'));
    if (role !== 'owner') assert.ok(state.requests.every(request => !['/v1/apps', '/v1/action-access', '/v1/access/options', '/v1/grants'].includes(request.path)), 'Members must not call owner metadata APIs.');
  });
  await check('Agent identity does not render human owner controls', { kind: 'agent' }, async ({ page }) => {
    await page.getByRole('region', { name: 'Capability access', exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Workspace', exact: true }).count(), 0);
    assert.equal(await button(page, 'Agents').count(), 0); assert.equal(await button(page, 'People access').count(), 0);
  });
  await check('Session loading evidence and release', { meGate: gate(), width: 375 }, async test => {
    await test.page.getByRole('heading', { name: 'Opening your workspace…', exact: true }).waitFor();
    assert.equal(await test.page.locator('.console').getAttribute('aria-busy'), 'true'); await screenshot(test, 'session-loading');
    test.state.meGate.release(); await appsReady(test.page);
  });
  await check('Apps loading evidence and release', { appsGate: gate(), width: 375 }, async test => {
    await (baseline?test.page.getByText('Loading apps…',{exact:true}):test.page.getByRole('status', { name: 'Loading apps…', exact: true })).filter({visible:true}).waitFor(); await screenshot(test, 'apps-loading');
    test.state.appsGate.release(); await appsReady(test.page);
  });
  await check('Apps empty state evidence', { empty: true, width: 375 }, async test => {
    await appsReady(test.page); await test.page.getByText(baseline?'No connected apps yet. Choose All apps to explore integrations.':'No connected apps yet', { exact: true }).waitFor(); await screenshot(test, 'apps-empty');
  });
  await check('Apps error evidence and refresh recovery', { appsStatus: 503, width: 375 }, async test => {
    await test.page.locator('.apps').getByRole('alert').waitFor(); await screenshot(test, 'apps-error');
    test.state.appsStatus = 200; await button(test.page, 'Refresh apps').click(); await appsReady(test.page);
  });
}
async function appearanceChecks() {
  for (const media of ['light', 'dark']) await check(`System preference follows ${media} and live media changes`, { media }, async test => {
    const { page } = test; await appsReady(page); await themeReady(page, 'system');
    await screenshot(test, `system-${media}`);
    await page.emulateMedia({ colorScheme: media === 'light' ? 'dark' : 'light' }); await themeReady(page, 'system');
    const appearance = page.getByRole('combobox', { name: 'Appearance', exact: true });
    await appearance.selectOption('light'); await themeReady(page, 'light');
    await page.emulateMedia({ colorScheme: 'dark' }); await themeReady(page, 'light');
    await appearance.selectOption('dark'); await themeReady(page, 'dark');
    await page.emulateMedia({ colorScheme: 'light' }); await themeReady(page, 'dark');
  });
  await check('Appearance persists through reload, unrelated keys untouched', {}, async ({ page }) => {
    await appsReady(page); await page.evaluate(() => localStorage.setItem('fixture-unrelated', 'preserve'));
    const appearance = page.getByRole('combobox', { name: 'Appearance', exact: true });
    await appearance.selectOption('dark'); await themeReady(page, 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('capykit.appearance')), 'dark');
    await page.reload(); await appsReady(page); await themeReady(page, 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture-unrelated')), 'preserve');
    await appearance.selectOption('system'); await page.reload(); await appsReady(page); await themeReady(page, 'system');
  });
  await check('Blocked localStorage leaves working system theme and interactive selector', { blockStorage: true, media: 'dark', signedIn: false, route: '/' }, async ({ page }) => {
    await signInReady(page); await themeReady(page, 'system');
    await page.getByRole('combobox', { name: 'Appearance', exact: true }).selectOption('light'); await themeReady(page, 'light');
    await page.reload(); await signInReady(page); await themeReady(page, 'system');
  });
  await check('Invalid stored appearance falls back to system', { theme: 'not-a-mode', media: 'dark' }, async ({ page }) => { await appsReady(page); await themeReady(page, 'system'); });
  for (const mode of ['light', 'dark', 'system']) await check(`Pre-React bootstrap for ${mode}`, { theme: mode, scriptGate: gate(), media: 'dark' }, async ({ page, state }) => {
    await page.waitForFunction(() => document.documentElement.getAttribute('data-astryx-theme') === 'neutral');
    assert.equal(await page.locator('html').getAttribute('data-theme'), mode === 'system' ? null : mode);
    assert.equal(await page.locator('.console').count(), 0, 'Module is held: this proves bootstrap before React.');
    state.scriptGate.release(); await appsReady(page); await themeReady(page, mode);
  });
}
try {
  const bundled = [...files.values()].map(value => value.toString()).join('\n');
  if (baseline) {
    assert.equal(revision, '71b392fd43b10d8ba6a8f4244fd1b628abda6ae7', 'BEFORE must use the specified baseline revision.');
    assert.equal(buildSha256, '0665ec3da3393ad936a29954fd8b45681519a90ec606293dd91a908bd20b6cc0', 'Do not overwrite BEFORE evidence with a parent rebuild.');
  } else {
    assert.ok(bundled.includes('astryx-button') && html.toString().includes('/assets/theme-bootstrap.js') && files.get('/assets/theme-bootstrap.js')?.toString().includes('capykit.appearance'), 'AFTER requires rebuilt Astryx runtime and CSP-safe pre-React appearance bootstrap.');
    const installed = JSON.parse(await readFile(join(root, 'node_modules/@astryxdesign/core/package.json'), 'utf8'));
    assert.equal(installed.version, '0.7.0'); metadata.astryxVersion = installed.version;
  }
  if (!contrastOnly) for (const width of [320, 375, 430, 1440]) for (const theme of baseline ? ['legacy'] : ['light', 'dark']) {
    const settings = { width, ...(baseline ? {} : { theme }) }, suffix = baseline ? `${width}` : `${width}-${theme}`;
    await check(`${phase.toUpperCase()} Apps ${suffix}`, settings, async test => {
      await appsReady(test.page); await shellGeometry(test.page); await themeReady(test.page, theme);
      if (!baseline || [1440, 375].includes(width)) await screenshot(test, `apps-${suffix}`);
    });
    await check(`${phase.toUpperCase()} sign-in ${suffix}`, { ...settings, signedIn: false, route: '/' }, async test => {
      await signInReady(test.page); await shellGeometry(test.page); await themeReady(test.page, theme);
      if (!baseline || [1440, 375].includes(width)) await screenshot(test, `sign-in-${suffix}`);
    });
  }
  if (!contrastOnly) await functionalChecks();
  if (!baseline) {
    if (!contrastOnly) await appearanceChecks();
    await destructiveContrastChecks();
  }
} catch (error) { results.push({ name: 'harness readiness', passed: false, error: error.message }); }
finally {
  await browser.close();
  metadata.passed = results.length > 0 && results.every(r => r.passed);
  await writeFile(join(evidence, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify(metadata, null, 2));
  if (!metadata.passed) process.exitCode = 1;
}
