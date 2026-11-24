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
const approvalPath = rotationPath + '/approval';
const fixtureCredentialId = 'AQID';

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
    if (relogin) await context.addInitScript(({ id }) => {
      Object.defineProperty(navigator.credentials, 'get', {
        value: async ({ publicKey }) => {
          if (publicKey.userVerification !== 'required') throw new Error('Missing user verification');
          if (window.cancelFixtureApproval) return null;
          const bytes = Uint8Array.of(1, 2, 3).buffer;
          return { id, rawId: bytes, type: 'public-key', getClientExtensionResults: () => ({}),
            response: { authenticatorData: bytes, clientDataJSON: bytes, signature: bytes } };
        },
      });
    }, { id: fixtureCredentialId });
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
      if (relogin && pathname === approvalPath && req.method() === 'POST') {
        const { oldPassword: entered, newPassword: proposed } = req.postDataJSON();
        if (entered === wrongPassword && proposed === newPassword) {
          submitted.push('wrong-password');
          return route.fulfill({ status: 400, json: { code: 'invalid_credentials', error: '原密码不正确' } });
        }
        if (entered !== oldPassword || proposed !== newPassword) return route.fulfill({ status: 400 });
        submitted.push('approval-requested');
        return route.fulfill({ json: {
          challenge: 'AQID', rpId: base.hostname, userVerification: 'required',
          allowCredentials: [{ id: fixtureCredentialId, type: 'public-key' }],
        } });
      }
      if (pathname === rotationPath && req.method() === 'POST') {
        const body = req.postDataJSON();
        if (provider === 'local' && body?.oldPassword === wrongPassword) {
          submitted.push('wrong-password');
          return route.fulfill({ status: 400, json: { code: 'invalid_credentials', error: '原密码不正确' } });
        }
        const exactNewPassword = body?.newPassword === newPassword && Object.keys(body).length === (relogin ? 3 : 2);
        if (!exactNewPassword || body?.oldPassword !== oldPassword || (relogin && body.approval?.id !== fixtureCredentialId)) {
          submitted.push('unexpected');
          return route.fulfill({ status: 400, json: { error: 'Unexpected fixture payload' } });
        }
        submitted.push('matched');
        authenticated = false;
        return route.fulfill({ json: { ok: true } });
      }
      if (pathname === '/api/client-events') return route.fulfill({ json: { ok: true } });
      if (req.method() !== 'GET') return route.fulfill({ status: 403, json: { error: 'Unexpected fixture write' } });
      return route.fulfill({ json: resolveFixture(pathname) ?? {} });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', () => scriptErrors++);
    if (!owner) {
      await page.goto(new URL('/cds-settings#users', base).href, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(url => url.hash === '#activity', { timeout: 15_000 });
      assert.equal(await page.getByRole('tab', { name: '用户管理' }).count(), 0, 'Member cannot open user management');
    }
    await page.goto(new URL('/project-list', base).href, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^用户设置/ }).click();
    await page.getByRole('menuitem', { name: '个人设置', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/personal-settings');
    await page.getByRole('heading', { name: '个人设置', exact: true }).waitFor();
    const previousPassword = page.locator('input[autocomplete="current-password"]');
    assert.equal(await previousPassword.isVisible(), form, `${provider} account (${owner ? 'owner' : 'member'}) password form`);
    if (form) {
      const newPasswordField = page.locator('input[autocomplete="new-password"]');
      const button = page.getByRole('button', { name: relogin ? '使用通行密钥批准并改密' : '修改密码', exact: true });
      const submit = async (path = rotationPath) => {
        const [response] = await Promise.all([
          page.waitForResponse(res => res.request().method() === 'POST'
            && new URL(res.url()).pathname.replace(/^\/_cds/, '') === path),
          button.click(),
        ]);
        return response.status();
      };
      if (relogin || provider === 'local') {
        await previousPassword.fill(wrongPassword);
        await newPasswordField.fill(newPassword);
        assert.equal(await submit(relogin ? approvalPath : rotationPath), 400);
        await page.getByText('原密码不正确').waitFor();
        assert.equal(new URL(page.url()).pathname, '/personal-settings', 'Wrong password keeps the settings page');
      }
      await previousPassword.fill(oldPassword);
      await newPasswordField.fill(newPassword);
      if (relogin) {
        await page.evaluate(() => { window.cancelFixtureApproval = true; });
        assert.equal(await submit(approvalPath), 200);
        await page.getByText('管理员通行密钥未完成验证，请重试。').waitFor();
        assert.deepEqual(submitted, ['wrong-password', 'approval-requested']);
        await page.evaluate(() => { window.cancelFixtureApproval = false; });
      }
      assert.equal(await submit(), 200);
      await page.getByText('密码已修改，请使用新密码重新登录。', { exact: true }).waitFor({ timeout: 8_000 });
      assert.equal(await previousPassword.count(), 0, 'Success removes password fields');
      await page.getByRole('link', { name: '重新登录', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/login', { timeout: 8_000 });
      await page.getByRole('heading', { name: '登录 CDS 控制台' }).waitFor();
    }
    const expected = form ? ['matched'] : [];
    if (relogin) expected.unshift('wrong-password', 'approval-requested', 'approval-requested');
    if (provider === 'local') expected.unshift('wrong-password');
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
    { provider: 'local', owner: false, form: true, relogin: false },
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
