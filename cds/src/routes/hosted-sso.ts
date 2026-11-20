import { Router, urlencoded, type Request, type Response } from 'express';
import { GH_SESSION_COOKIE, sessionCookieName } from './auth.js';
import { isRecentAuthentication, readAuthCookie, trustedAuthOrigin } from './passkeys.js';
import { isApplicationPath, preferenceKey, siteReturnPath, type HostedSso, type Site } from '../services/hosted-sso.js';
import type { AuthService } from '../services/auth-service.js';
import type { StateService } from '../services/state.js';
import type { CdsUser } from '../domain/auth.js';
import type { Collection } from 'mongodb';
import type Provider from 'oidc-provider';
import { loadOidcSigningMaterial, mongoOidcAdapter, type OidcArtifact } from '../infra/auth-store/oidc-store.js';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function page(res: Response, title: string, content: string, status = 200, returnOrigin?: URL): void {
  res.status(status).type('html');
  res.set('Referrer-Policy', 'same-origin');
  const formSites = returnOrigin ? `'self' ${returnOrigin.origin}` : "'self'";
  res.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formSites}; base-uri 'none'; frame-ancestors 'none'`);
  res.send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
    <style>
      :root{color-scheme:light dark;font:16px system-ui,sans-serif}
      body{margin:0;padding:2rem 1rem;background:Canvas;color:CanvasText}
      main{margin:10vh auto 0;max-width:29rem;border:1px solid GrayText;padding:1.6rem;border-radius:.85rem;overflow-wrap:anywhere}
      h1{margin:0 0 .7rem;font-size:1.4rem}p{line-height:1.55}form{display:grid;gap:.5rem;margin:1.3rem 0}
      button{font:inherit;text-align:left;min-height:2.75rem;padding:.45rem .7rem;cursor:pointer;border-radius:.45rem;border:1px solid GrayText}
      button small{display:block}a{color:LinkText}
    </style><main><h1>${escape(title)}</h1>${content}</main></html>`);
}

function accountPage(res: Response, site: Site, accounts: CdsUser[], target: string, retry: boolean): void {
  const login = `/login?choose_account=1&redirect=${encodeURIComponent(target)}`;
  const choices = accounts.map(user => `<button name="account" value="${escape(user.id)}">${escape(user.name)}<small>${escape(user.username || user.githubLogin)}</small></button>`).join('');
  const message = retry ? '<p>选定账号的会话已过期或访问权限已变更。请重新验证该账号，也可以选择其他有权访问的账号。</p>' : '';
  page(res, '选择 CDS 账号', `<p>登录到 <strong>${escape(site.origin.host)}</strong></p>${message}
    <form method="post" action="${escape(target)}">${choices}<button name="cancel" value="1">取消登录</button></form>
    <a href="${escape(login)}">使用其他 CDS 账号</a>`, 200, site.origin);
}

const CLIENT_PREFIX = 'cds-site:';
const INTERACTION_PATH = '/api/hosted-sso/interaction/';
const OIDC_SESSION_MS = 8 * 60 * 60_000;

async function createOidcProvider(sso: HostedSso, auth: AuthService, store: Collection<OidcArtifact>): Promise<Provider> {
  const { default: Provider, interactionPolicy } = await import('oidc-provider');
  const signing = await loadOidcSigningMaterial(store);
  const policy = interactionPolicy.base();
  policy.add(new interactionPolicy.Prompt({ name: 'select_account', requestable: true }), 0);
  policy.get('login')?.checks.add(new interactionPolicy.Check(
    'cds_site_account', 'Choose the account authorized for this site', ctx => !ctx.oidc.result?.login,
  ));
  const provider = new Provider(new URL('/api/oidc', sso.authority).toString(), {
    adapter: mongoOidcAdapter(store, clientId => {
      const site = clientSite(sso, clientId);
      if (!site?.application) return undefined;
      return {
        client_id: clientId, client_name: site.label,
        redirect_uris: [new URL(site.application.callbackPath, site.origin).toString()],
        response_types: ['code'], grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'RS256',
      };
    }),
    jwks: { keys: [signing.jwk] },
    cookies: {
      keys: [signing.cookieKey],
      names: { session: '__Host-cds-oidc-session', interaction: '__Secure-cds-oidc-interaction', resume: '__Secure-cds-oidc-resume' },
      long: { path: '/', secure: true, sameSite: 'lax' },
      short: { secure: true, sameSite: 'lax' },
    },
    interactions: { policy, url: (_ctx, interaction) => `${INTERACTION_PATH}${interaction.uid}` },
    features: { devInteractions: { enabled: false }, userinfo: { enabled: true }, resourceIndicators: { enabled: false } },
    responseTypes: ['code'], scopes: ['openid'], claims: { openid: ['sub'] },
    pkce: { required: () => true },
    // The provider's browser session changes when another site selects a different account.
    // Site grants are checked against their own CDS session in findAccount.
    expiresWithSession: () => false,
    ttl: { AuthorizationCode: 60, IdToken: 120, AccessToken: OIDC_SESSION_MS / 1000, Grant: OIDC_SESSION_MS / 1000,
      Interaction: 300, Session: OIDC_SESSION_MS / 1000 },
    async findAccount(ctx, userId, token) {
      if (token) {
        const grant = token.grantId ? await store.findOne({ _id: `Binding:${token.grantId}`, expiresAt: { $gt: new Date() } }) : null;
        const binding = grant?.authorization;
        const site = binding ? sso.site(binding.siteId) : undefined;
        if (!binding || !site?.application || site.revision !== binding.revision || ctx.oidc.client?.clientId !== `${CLIENT_PREFIX}${site.id}`) return undefined;
        const verified = await sso.authorized(site, binding.cdsToken);
        if (verified?.user.id !== userId) return undefined;
      } else {
        const user = await auth.findUserById(userId);
        if (user?.status !== 'active') return undefined;
      }
      return { accountId: userId, claims: () => ({ sub: userId }) };
    },
  });
  provider.proxy = true;
  return provider;
}

function clientSite(sso: HostedSso, client: unknown): Site | undefined {
  return typeof client === 'string' && client.startsWith(CLIENT_PREFIX) ? sso.site(client.slice(CLIENT_PREFIX.length)) : undefined;
}

export function createHostedSsoRouter(deps: {
  sso: HostedSso;
  auth: AuthService;
  state: StateService;
  accepting: () => boolean;
  oidcStore?: Collection<OidcArtifact>;
}): Router {
  const { sso, auth, state } = deps;
  const oidcStore = Number(process.versions.node.split('.')[0]) >= 22 ? deps.oidcStore : undefined;
  const router = Router();
  const primaryHost = (req: Request): boolean => deps.accepting() && req.get('x-cds-internal') !== '1'
    && req.get('host')?.toLowerCase() === sso.authority.host;
  const validate = (req: Request) => auth.validateSession(readAuthCookie(req.get('cookie'), sessionCookieName(GH_SESSION_COOKIE, true)), { renew: false });

  router.use(['/hosted-sso', '/oidc'], (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
    res.locals.cdsSuppressRequestBodyLog = true;
    next();
  });

  // Only the preview proxy supplies this source host. The response is a public capability
  // flag or a same-site link, and never carries a browser session or a CDS identity.
  function panelSite(req: Request): Site | undefined {
    if (!oidcStore || !deps.accepting() || req.get('x-cds-internal') !== '1'
      || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) return;
    return sso.siteForHost(req.get('x-cds-source-host')?.toLowerCase() ?? '');
  }

  router.get('/hosted-sso/panel/status', (req, res) => {
    res.json({ enabled: Boolean(panelSite(req)) });
  });

  router.get('/hosted-sso/panel/start', (req, res) => {
    const site = panelSite(req);
    if (!site) {
      res.status(404).json({ error: '项目尚未开启 CDS 登录，请使用项目提供的登录方式。' });
      return;
    }
    const login = new URL(site.application.loginPath, site.origin);
    const back = siteReturnPath(typeof req.query.returnUrl === 'string' ? req.query.returnUrl : '/');
    const path = back.split('?')[0];
    login.searchParams.set('returnUrl', path === site.application.loginPath || path === site.application.callbackPath ? '/' : back);
    if (req.query.switchAccount === 'true') login.searchParams.set('switchAccount', 'true');
    res.redirect(303, login.pathname + login.search);
  });

  if (oidcStore) {
    const store = oidcStore;
    let initializing: Promise<Provider> | undefined;
    const provider = () => (initializing ??= createOidcProvider(sso, auth, store).catch(error => { initializing = undefined; throw error; }));
    router.use('/oidc', (req, res, next) => {
      if (!primaryHost(req)) { res.sendStatus(404); return; }
      void provider().then(instance => instance.callback()(req, res)).catch(next);
    });
    const interaction = async (req: Request, res: Response): Promise<void> => {
      if (!primaryHost(req) || (req.method === 'POST' && req.get('origin') !== sso.authority.origin)) { res.sendStatus(403); return; }
      const instance = await provider();
      let detail;
      try { detail = await instance.interactionDetails(req, res); }
      catch (error) {
        const { errors } = await import('oidc-provider');
        if (!(error instanceof errors.SessionNotFound)) throw error;
        page(res, '站点登录链接已失效', '<p>请返回原站点并重新登录。</p>', 400);
        return;
      }
      const site = clientSite(sso, detail.params.client_id);
      if (detail.uid !== req.params.id || !site?.application
        || detail.params.redirect_uri !== new URL(site.application.callbackPath, site.origin).toString()) { res.sendStatus(403); return; }
      if (req.method === 'POST' && req.body?.cancel === '1') {
        await instance.interactionFinished(req, res, { error: 'access_denied', error_description: 'The user cancelled sign-in' }, { mergeWithLastSubmission: false });
        return;
      }
      const browser = await sso.browser(req.get('cookie'));
      if (!browser) { res.sendStatus(429); return; }
      if (browser.newCookie) res.append('Set-Cookie', browser.newCookie);
      await sso.rememberCurrent(browser.accounts, req.get('cookie'));
      const prompts = typeof detail.params.prompt === 'string' ? detail.params.prompt.split(/\s+/) : [];
      const reauthenticate = prompts.includes('login');
      const selectExplicitly = reauthenticate || prompts.includes('select_account');
      const selected = req.method === 'POST' ? req.body?.account : selectExplicitly ? undefined : browser.accounts.preferences.get(preferenceKey(site));
      if (typeof selected === 'string') {
        const cdsToken = browser.accounts.sessions.get(selected);
        const verified = cdsToken && await sso.authorized(site, cdsToken);
        if (cdsToken && verified) {
          const authenticatedAt = Math.floor(Date.parse(verified.session.createdAt) / 1000);
          const maxAge = detail.params.max_age === undefined ? undefined : Number(detail.params.max_age);
          const freshEnough = maxAge === 0 || reauthenticate
            ? authenticatedAt >= (detail.iat ?? 0)
            : maxAge === undefined || Math.floor(Date.now() / 1000) - authenticatedAt <= maxAge;
          if (!freshEnough) {
            const path = `${INTERACTION_PATH}${encodeURIComponent(detail.uid)}`;
            accountPage(res, site, [], path, true);
            return;
          }
          const grant = new instance.Grant({ accountId: selected, clientId: `${CLIENT_PREFIX}${site.id}` });
          grant.addOIDCScope('openid');
          const grantId = await grant.save();
          await store.insertOne({ _id: `Binding:${grantId}`, expiresAt: new Date(Date.now() + OIDC_SESSION_MS),
            authorization: { siteId: site.id, revision: site.revision, cdsToken } });
          await sso.rememberSelection(browser.accounts, site, selected);
          await auth.recordActivity({ userId: selected, userLogin: verified.user.username || verified.user.githubLogin,
            action: 'hosted-sso.authorize', targetType: 'branch', targetId: site.id, summary: '授权登录站点账号' });
          await instance.interactionFinished(req, res, { login: { accountId: selected, ts: authenticatedAt, remember: false }, consent: { grantId },
            ...(prompts.includes('select_account') ? { select_account: {} } : {}) }, { mergeWithLastSubmission: false });
          return;
        }
      }
      const accounts = await sso.accountsForSite(browser.accounts, site);
      accountPage(res, site, accounts, `${INTERACTION_PATH}${encodeURIComponent(detail.uid)}`, Boolean(selected));
    };
    router.get('/hosted-sso/interaction/:id', (req, res, next) => { void interaction(req, res).catch(next); });
    router.post('/hosted-sso/interaction/:id', urlencoded({ extended: false, limit: '8kb', inflate: false }), (req, res, next) => { void interaction(req, res).catch(next); });
  }

  router.get('/hosted-sso/sites', (req, res, next) => { void (async () => {
    const verified = primaryHost(req) ? await validate(req) : null;
    if (!verified?.user.isSystemOwner) { res.sendStatus(403); return; }
    const users = (await auth.listUsers()).map(user => ({ id: user.id, name: user.name, username: user.username ?? user.githubLogin }));
    res.json({ sites: state.getAllBranches().filter(branch => branch.hostedSso || sso.originsForBranch(branch.id).length > 0).map(branch => ({
      id: branch.id, name: branch.branch, projectId: branch.projectId, origins: sso.originsForBranch(branch.id), config: branch.hostedSso ?? null,
      clientId: `${CLIENT_PREFIX}${branch.id}`,
    })), users, issuer: oidcStore ? new URL('/api/oidc', sso.authority).toString() : null });
  })().catch(next); });

  router.put('/hosted-sso/sites/:branchId', (req, res, next) => { void (async () => {
    const verified = primaryHost(req) && req.get('origin') === sso.authority.origin ? await validate(req) : null;
    if (!verified?.user.isSystemOwner || !isRecentAuthentication(verified.session, true)) {
      res.status(403).json({ error: '请先在 CDS 用户菜单重新验证通行密钥，再修改站点授权。', code: 'passkey_verification_required' });
      return;
    }
    const branch = state.getBranch(req.params.branchId);
    if (!branch) { res.status(404).json({ error: '找不到对应分支，请刷新站点列表。' }); return; }
    const origin = trustedAuthOrigin(req.body?.origin);
    const denied = req.body?.deniedUserIds;
    const suspended = req.body?.suspended === true;
    if (!oidcStore || !origin || !Array.isArray(denied)
      || denied.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) {
      res.status(400).json({ error: '请选择当前项目的托管入口和有效账号。' });
      return;
    }
    const app = req.body?.application;
    if ((!suspended || app) && (!isApplicationPath(app?.callbackPath) || !isApplicationPath(app?.loginPath) || app.callbackPath === app.loginPath)) {
      res.status(400).json({ error: '请填写项目实现的站内登录路径和回调路径。' });
      return;
    }
    let config;
    try {
      config = sso.configure(branch.id, origin, [...new Set<string>(denied)],
        app ? { callbackPath: app.callbackPath, loginPath: app.loginPath } : undefined, suspended);
    } catch {
      res.status(409).json({ error: '请选择与 CDS 同注册域、正在发布且支持项目成员授权的 HTTPS 入口。' });
      return;
    }
    await sso.updateSite(branch.id, config);
    await auth.recordActivity({ userId: verified.user.id, userLogin: verified.user.username || verified.user.githubLogin,
      action: 'hosted-sso.configure', targetType: 'branch', targetId: branch.id, summary: suspended ? '暂停站点 CDS 登录' : '更新托管站点登录授权' });
    res.json({ success: true });
  })().catch(next); });

  return router;
}
