// Local controlled browser regression; never connects to a real gateway or starts model inference.
// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright module when it is not a workspace dependency.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
import crypto from 'node:crypto';
const root = process.env.CHECK_ROOT || fileURLToPath(new URL('../', import.meta.url));
const out = process.env.CHECK_OUT || path.join(tmpdir(), `llmgw-provider-workspace-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
process.env.LLMGW_WEB_BASE = '/';
const port = Number(process.env.CHECK_PORT || 8294);
const origin = `http://127.0.0.1:${port}`;
let mode = 'few';
const calls = [];
const tenant = { id: 'fixture', name: '审核团队', role: 'owner', isInternal: true, teamIds: [] };
const provider = { id: 'p0', name: 'preview-readability-20261115-alpha', platformType: 'openai', enabled: true, hasKey: true, authority: 'llm_gateway', apiUrl: 'http://controlled.invalid/v1' };
const base = { id: 'm0', platformId: 'p0', name: 'preview-readability-alpha', modelName: 'preview-readability-alpha', enabled: true, hasKey: false, authority: 'llm_gateway', capabilities: [{ type: 'chat', value: true }], priceCurrency: 'USD' };
const models = () => mode === 'many' ? Array.from({ length: 30 }, (_, i) => ({ ...base, id: 'm' + i, modelName: 'fixture-model-' + String(i).padStart(3, '0') })) : mode === 'empty' ? [] : [base];
async function mock(route) {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.replace(/^\/gw/, '');
    calls.push({ method: request.method(), path: endpoint });
    if (request.method() !== 'GET' && endpoint !== '/auth/login') throw Error('business write forbidden');
    let data = { items: [], total: 0 };
    if (endpoint === '/auth/login') data = { token: 'local-fixture-only', expiresAt: '2099-01-01T00:00:00Z', username: 'owner', displayName: '审核', tenant, mustChangePassword: false };
    else if (endpoint === '/healthz') data = { status: 'ok', mapHomeUrl: 'https://example.invalid' };
    else if (endpoint === '/platforms') data = { items: mode === 'empty' ? [] : [provider, { ...provider, id: 'p1', name: 'preview-readability-20261115-beta', enabled: false }] };
    else if (endpoint === '/models') data = { items: models() };
    else if (endpoint === '/logical-models') data = { items: [{ id: 'l0', publicId: 'preview-public-alpha', offerings: [{ targetKind: 'model', targetId: 'm0' }] }] };
    else if (endpoint === '/overview') data = { totalRequests: 0, recentRequests: [], serviceKeys: { total: 0 }, estimatedCosts: [], topUsers: [], topAppCallers: [], topModels: [] };
    return route.fulfill({ json: { success: true, data, error: null } });
}
const server = await createServer({ root, cacheDir: path.join(out, '.vite-cache'), server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root, fs.realpathSync(root + '/node_modules')] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
const results = [], failures = [];
const check = (value, message) => { results.push({ check: message, passed: !!value }); if (!value)
    failures.push(message); };
const source = {};
for (const f of ['src/pages/PlatformsPage.tsx', 'src/pages/PlatformsPage.css', 'src/components/ProviderModelsPanel.tsx', 'src/components/CollectionView.tsx', 'src/components/CollectionView.css'])
    source[f] = crypto.createHash('sha256').update(fs.readFileSync(root + '/' + f)).digest('hex');
try {
    for (const [width, theme] of (process.env.CHECK_REPRESENTATIVE ? [[1440, 'light']] : [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']])) {
        mode = 'few';
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
        await context.route('**/gw/**', mock);
        const p = await context.newPage();
        const errors = [];
        p.setDefaultTimeout(10000);
        p.setDefaultNavigationTimeout(30000);
        p.on('pageerror', e => errors.push(e.message));
        await p.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
        await p.locator('#llmgw-username').fill('owner');
        await p.locator('#llmgw-password').fill('local-fixture');
        await p.getByRole('button', { name: '进入租户工作区', exact: true }).click();
        await p.waitForURL(origin + '/');
        const ready = async () => { await p.goto(origin + '/platforms', { waitUntil: 'domcontentloaded' }); await p.locator('.lg-collection-provider-row').first().waitFor(); await p.evaluate(t => { document.documentElement.dataset.theme = t; localStorage.setItem('llmgw-theme', t); }, theme); await p.evaluate(() => document.fonts.ready); };
        await ready();
        const measure = async (name) => { await p.waitForTimeout(100); await p.screenshot({ path: `${out}/${name}-${width}-${theme}.png` }); const m = await p.evaluate(() => { const rect = s => { const e = document.querySelector(s); if (!e)
            return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; }; return { firstRow: rect('.lg-collection-provider-row'), models: rect('.lg-collection-owned-table tbody tr'), workspace: rect('.lg-collection-workspace'), pane: rect('.lg-collection-pane'), extras: rect('.lg-provider-maintenance-actions'), overflow: document.documentElement.scrollWidth > innerWidth }; }); results.push({ width, theme, name, ...m }); check(!m.overflow, `${width}/${theme}/${name}: no document overflow`); return m; };
        const listGeometry = await measure('list');
        if (width === 390) {
            const innerBorders = await p.locator('.lg-collection-provider-row:first-child td').evaluateAll(es => es.map(e => { const s = getComputedStyle(e); return parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth); }));
            check(innerBorders.every(width => width === 0), `${width}/${theme}/one provider remains one visual group without field borders`);
        }

        if (width === 1440) {
            const actionAlignment = await p.evaluate(() => {
                const head = document.querySelector('.lg-collection-provider-table th:last-child');
                const action = document.querySelector('.lg-provider-row-actions > button');
                return Math.abs(head.getBoundingClientRect().left + parseFloat(getComputedStyle(head).paddingLeft) - action.getBoundingClientRect().left);
            });
            check(actionAlignment <= 1, `${width}/${theme}/action column follows the same header and data alignment`);
        }
        check(listGeometry.firstRow.y <= (width === 390 ? 330 : 300), `${width}/${theme}/first provider appears before baseline packaging`);
        const entry = p.getByRole('button', { name: /查看 preview-readability-20261115-alpha 的已接入模型/ });
        await entry.click();
        await p.locator('.lg-collection-close').waitFor();
        const geometry = await measure('models');
        check(await p.getByRole('heading', { name: provider.name, level: 1, exact: true }).count() === 1 && await p.locator('.lg-provider-page h1').count() === 1, `${width}/${theme}/selected supplier owns the single page heading`);

        check(geometry.pane.width >= geometry.workspace.width * .95, `${width}/${theme}/maintenance uses complete workspace`);
        check(geometry.pane.bottom - geometry.models.bottom <= 32, `${width}/${theme}/single model ends naturally`);
        const modelText = await p.locator('.lg-collection-owned-table tbody tr:first-child td:first-child strong').evaluate(e => { const r = e.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(e); const t = range.getBoundingClientRect(); return { width: r.width, complete: t.left >= r.left - 1 && t.right <= r.right + 1 }; });
        check(modelText.complete && (width !== 390 || modelText.width >= width - 80), `${width}/${theme}/complete model identity has readable width`);
        check(await p.getByText('preview-readability-alpha', { exact: true }).isVisible(), `${width}/${theme}/model full name visible`);
        check(await p.locator('.lg-collection-pagination').count() === 0, `${width}/${theme}/few models no pagination`);
        const publicLink = p.getByRole('link', { name: '查看公开模型', exact: true });
        check(await publicLink.count() === 1, `${width}/${theme}/single public association skips unnecessary selection`);
        if (await publicLink.count()) {
            const publicUrl = new URL(await publicLink.getAttribute('href'), origin);
            check(publicUrl.searchParams.get('model') === 'preview-public-alpha' && publicUrl.searchParams.get('ownedFocus') === 'm0' && !publicUrl.searchParams.has('ownedSelected'), `${width}/${theme}/single public direct link preserves original model context`);
        }
        await p.locator('.lg-collection-close').click();
        check(await entry.evaluate(e => e === document.activeElement), `${width}/${theme}/return restores trigger focus`);
        await p.getByRole('button', { name: '连接配置', exact: true }).first().click();
        await measure('connection');
        await p.getByRole('button', { name: '编辑连接', exact: true }).click();
        await measure('connection-edit');
        const nameField = p.getByRole('textbox', { name: '平台名称', exact: true });
        const nameRect = await nameField.boundingBox();
        check(nameRect.y >= 56 && nameRect.y + nameRect.height < 520, `${width}/${theme}/connection editing starts in the first screen`);
        check(await p.locator('.lg-collection-pane .lg-collection-facts').count() === 0, `${width}/${theme}/edit replaces repeated readonly facts`);
        check(await nameField.evaluate(e => e === document.activeElement), `${width}/${theme}/edit focuses first field`);
        await p.locator('.lg-collection-pane').getByRole('button', { name: '取消', exact: true }).click();
        check(await p.getByRole('button', { name: '编辑连接', exact: true }).evaluate(e => e === document.activeElement), `${width}/${theme}/cancel restores original edit entry focus`);

        await p.locator('.lg-collection-close').click();
        mode = 'many';
        await ready();
        await entry.click();
        await measure('many');
        const wheelTo = async (locator) => { let wheels = 0; for (let i = 0; i < 12; i++) {
            const r = await locator.boundingBox();
            if (r && r.y >= 56 && r.y + r.height <= p.viewportSize().height) {
                results.push({ width, theme, stage: 'wheel-target', text: await locator.innerText(), wheels, rect: r });
                return true;
            }
            await p.mouse.move(width * .65, p.viewportSize().height * .7);
            await p.mouse.wheel(0, 360);
            wheels++;
            await p.waitForTimeout(80);
        } return false; };
        const next = p.getByRole('button', { name: '下一页', exact: true });
        check(await next.isEnabled(), `${width}/${theme}/many models paginate`);
        check(await wheelTo(next), `${width}/${theme}/many first next control reachable by actual wheel`);
        await next.click();
        check(await p.getByRole('link', { name: 'fixture-model-011', exact: true }).count() === 1, `${width}/${theme}/next model page accessible`);
        check(await wheelTo(next), `${width}/${theme}/many second next control reachable by actual wheel`);
        await next.click();
        const last = p.getByRole('link', { name: 'fixture-model-029', exact: true });
        check(await wheelTo(last), `${width}/${theme}/many last model reachable by actual wheel`);
        await p.screenshot({ path: `${out}/many-last-${width}-${theme}.png` });
        mode = 'empty';
        await p.goto(origin + '/platforms', { waitUntil: 'domcontentloaded' });
        await p.getByText('名称', { exact: true }).first().waitFor();
        await measure('empty');
        check(errors.length === 0, `${width}/${theme}/pageerrors 0`);
        await context.close();
    }
}
catch (error) {
    failures.push(error.message.split('\n')[0]);
    throw error;
}
finally {
    await browser.close();
    await server.close();
    fs.writeFileSync(out + '/result.json', JSON.stringify({ provenance: 'production components with deterministic controlled API; not live acceptance', source, results, failures }, null, 2));
    console.log(JSON.stringify({ out, failures }));
    if (failures.length)
        process.exitCode = 1;
}
