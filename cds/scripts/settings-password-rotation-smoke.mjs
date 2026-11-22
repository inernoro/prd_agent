import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8870');
assert.equal(base.hostname, '127.0.0.1', 'Synthetic browser fixture requires a loopback server');
const executablePath = process.env.CDS_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const localLogin = { github: false, local: true, sso: false };
const capabilities = { durableUsers: true, userManagement: true, userActivity: true };
const rotationPath = '/api/auth/change-password';

async function check({ provider, owner, form, relogin }) {
  const oldPassword = randomBytes(18).toString('hex');
  const wrongPassword = `wrong-${oldPassword}`;
  const newPassword = randomBytes(18).toString('hex');
  const user = { id: `fixture-${provider}-${owner}`, name: 'Synthetic account', username: 'synthetic-account',
    authProvider: provider, isSystemOwner: owner };
  const submitted = [];
  let authenticated = true;
  let scriptErrors = 0;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await context.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== base.origin) return route.abort();
      const pathname = url.pathname.replace(/^\/_cds/, '');
      if (!pathname.startsWith('/api/')) return route.continue();
      if (isEventStream(pathname) || pathname === '/api/activity-stream') {
        return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      }
      if (pathname === '/api/auth/public-status') return route.fulfill({ json: {
        mode: 'basic', enabled: true, capabilities, loginMethods: localLogin, sso: { enabled: false },
      } });
      if (pathname === '/api/auth/status') return route.fulfill({ json: {
        enabled: true, mode: 'basic', authenticated, ...(authenticated ? { user, activeProvider: provider } : {}),
        approvalCapabilities: { operator: owner, accessRequests: owner },
      } });
      if (pathname === '/api/me') return route.fulfill(authenticated ? { json: { user } } : { status: 401, json: {} });
      if (pathname === '/api/auth/users') return route.fulfill({ json: { users: [] } });
      if (pathname === '/api/identity/connections') return route.fulfill({ json: { users: [], requests: [], unclaimed: [] } });
      if (pathname === '/api/auth/activity') return route.fulfill({ json: { activity: [] } });
      if (pathname === rotationPath && req.method() === 'POST') {
        const body = req.postDataJSON();
        const exactNewPassword = body?.newPassword === newPassword && Object.keys(body).length === 2;
        if (exactNewPassword && body?.oldPassword === wrongPassword) {
          submitted.push('wrong-password');
          return route.fulfill({ status: 400, json: { code: 'invalid_credentials', error: '原密码不正确' } });
        }
        if (!exactNewPassword || body?.oldPassword !== oldPassword) {
          submitted.push('unexpected');
          return route.fulfill({ status: 400, json: { error: 'Unexpected fixture payload' } });
        }
        submitted.push('matched');
        if (relogin) authenticated = false;
        return route.fulfill({ json: { ok: true } });
      }
      if (pathname === '/api/client-events') return route.fulfill({ json: { ok: true } });
      if (req.method() !== 'GET') return route.fulfill({ status: 403, json: { error: 'Unexpected fixture write' } });
      return route.fulfill({ json: resolveFixture(pathname) ?? {} });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', () => scriptErrors++);
    await page.goto(new URL('/cds-settings#users', base).href, { waitUntil: 'domcontentloaded' });
    const disclosure = page.locator('summary').filter({ hasText: '我的登录密码' });
    if (owner) {
      await disclosure.waitFor({ timeout: 15_000 });
      if (!(await disclosure.evaluate(node => node.parentElement.open))) await disclosure.click();
    } else {
      await page.waitForURL(url => url.hash === '#activity', { timeout: 15_000 });
      assert.equal(await disclosure.count(), 0, 'Member cannot open the user management tab');
    }
    const previousPassword = page.locator('input[autocomplete="current-password"]');
    assert.equal(await previousPassword.isVisible(), form, `${provider} account (${owner ? 'owner' : 'member'}) password form`);
    if (form) {
      const newPasswordField = page.locator('input[autocomplete="new-password"]');
      const submit = async () => {
        const [response] = await Promise.all([
          page.waitForResponse(res => res.request().method() === 'POST'
            && new URL(res.url()).pathname.replace(/^\/_cds/, '') === rotationPath),
          page.getByRole('button', { name: '修改密码', exact: true }).click(),
        ]);
        return response.status();
      };
      if (relogin) {
        await previousPassword.fill(wrongPassword);
        await newPasswordField.fill(newPassword);
        assert.equal(await submit(), 400);
        await page.getByText('原密码不正确').waitFor();
        assert.equal(new URL(page.url()).pathname, '/cds-settings', 'Wrong password keeps the settings page');
      }
      await previousPassword.fill(oldPassword);
      await newPasswordField.fill(newPassword);
      assert.equal(await submit(), 200);
      if (relogin) {
        await page.waitForURL(url => url.pathname === '/login', { timeout: 8_000 });
        await page.getByRole('heading', { name: '登录 CDS 控制台' }).waitFor();
        await page.getByRole('button', { name: '登录', exact: true }).waitFor();
      } else {
        await page.getByText('密码已修改，请使用新密码重新登录', { exact: true }).waitFor({ timeout: 8_000 });
      }
      assert.equal(new URL(page.url()).pathname, relogin ? '/login' : '/cds-settings');
    }
    const expected = form ? ['matched'] : [];
    if (relogin) expected.unshift('wrong-password');
    assert.deepEqual(submitted, expected, 'Password attempts use the exact expected fields');
    assert.equal(scriptErrors, 0, 'No page errors');
  } catch (error) {
    throw new Error(String(error?.message || error).replaceAll(wrongPassword, '[redacted]')
      .replaceAll(oldPassword, '[redacted]').replaceAll(newPassword, '[redacted]'));
  } finally { await context.close(); }
}

try {
  for (const fixture of [
    { provider: 'legacy', owner: true, form: true, relogin: true },
    { provider: 'local', owner: true, form: true, relogin: false },
    { provider: 'sso', owner: true, form: false, relogin: false },
    { provider: 'legacy', owner: false, form: false, relogin: false },
  ]) {
    try {
      await check(fixture);
      console.log(`PASS ${fixture.provider} ${fixture.owner ? 'owner' : 'member'}`);
    } catch (error) {
      console.error(`FAIL ${fixture.provider} ${fixture.owner ? 'owner' : 'member'} ${error.message}`);
      process.exitCode = 1;
    }
  }
} finally { await browser.close(); }
