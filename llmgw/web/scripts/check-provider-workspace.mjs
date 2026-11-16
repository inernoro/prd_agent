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
    else if (endpoint === '/platforms') data = { items: mode === 'empty' ? [] : mode === 'attention' ? [{ ...provider, keyStatus: 'unreadable', apiUrl: '', authority: 'map', recentCallStatus: 'quota_exhausted', recentCallAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z' }, { ...provider, id: 'p1', name: 'preview-readability-20261115-beta', enabled: false, hasKey: false }] : [provider, { ...provider, id: 'p1', name: 'preview-readability-20261115-beta', enabled: false }] };
    else if (endpoint === '/models') data = { items: models() };
    else if (endpoint === '/logical-models') data = { items: mode === 'attention' ? [] : [{ id: 'l0', publicId: 'preview-public-alpha', offerings: [{ targetKind: 'model', targetId: 'm0' }] }] };
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
for (const f of ['src/pages/PlatformsPage.tsx', 'src/pages/PlatformsPage.css', 'src/components/ProviderModelsPanel.tsx', 'src/components/ProviderCallStatus.tsx', 'src/components/CollectionView.tsx', 'src/components/CollectionView.css'])
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
        const firstProvider = p.locator('.lg-collection-provider-row').first();
        const summary = await firstProvider.evaluate((e, name) => ({ characters: e.innerText.replace(name, '').replace(/\s/g, '').length, text: e.innerText }), provider.name);
        results.push({ width, theme, stage: 'default-content', ...summary });
        check(summary.characters <= 60, `${width}/${theme}/default supplier summary avoids repeated configuration prose`);
        check(listGeometry.firstRow.height <= (width === 390 ? 180 : 90), `${width}/${theme}/few suppliers use natural compact rows with readable text`);
        for (const [label, name] of [['连接配置', /^连接配置$/], ['导入模型', /^(发现并)?导入模型$/]]) check(await firstProvider.getByRole('button', { name }).isVisible(), `${width}/${theme}/${label} remains a direct action`);
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
        const queryLayout = async () => p.locator('.lg-collection-view:visible > .lg-collection-toolbar').first().evaluate(e => {
            const rect = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, height: r.height, width: r.width }; };
            return { search: rect(e.querySelector('input')), filter: rect(e.querySelector('select')), count: rect(e.querySelector('.lg-collection-count')) };
        });
        const listQuery = await queryLayout();
        results.push({ width, theme, stage: 'list-query-layout', ...listQuery });
        if (width === 390) {
            check(listGeometry.firstRow.y <= 244, `${width}/${theme}/supplier starts before a second default query row`);
            check(Math.abs(listQuery.search.y - listQuery.filter.y) <= 1 && listQuery.search.height >= 44 && listQuery.filter.height >= 44, `${width}/${theme}/default search and status share one accessible control row`);
        } else check(listQuery.search.width >= 280 && listQuery.search.width <= 460, `${width}/${theme}/search has a deliberate width rather than filling the data workspace`);
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
        const importAction = p.locator('.lg-collection-pane').getByRole('button', { name: '导入模型', exact: true });
        const importRect = await importAction.boundingBox();
        const modelQuery = await queryLayout();
        results.push({ width, theme, stage: 'models-action-layout', importAction: importRect, ...modelQuery });
        check(importRect.y + importRect.height <= modelQuery.search.y + 1, `${width}/${theme}/model import belongs above the query to the current object workspace`);
        if (width === 390) {
            check(geometry.models.y <= 332, `${width}/${theme}/model data starts before the former second query row`);
            for (const stressWidth of [320, 375, 390]) {
                await p.setViewportSize({ width: stressWidth, height: 844 });
                const search = p.getByRole('searchbox', { name: '搜索上游模型或公开标识', exact: true });
                await search.fill('unmatched-long-query');
                const filter = p.locator('.lg-collection-provider-models').getByRole('combobox');
                await filter.selectOption('unregistered');
                const layout = await queryLayout();
                const selectedLabelFits = await filter.evaluate(e => {
                    const c = document.createElement('canvas').getContext('2d'), s = getComputedStyle(e); c.font = s.font;
                    return c.measureText(e.selectedOptions[0].text).width + 22 <= e.getBoundingClientRect().width;
                });
                check(selectedLabelFits && layout.search.width >= 120 && layout.count.right <= stressWidth - 8 && !await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${stressWidth}/${theme}/active long filter, editable query and zero count remain readable without overflow`);
                check(await search.inputValue() === 'unmatched-long-query' && await p.locator('.lg-collection-pane [aria-label="清单数量"]').innerText() === '0 / 1 项', `${stressWidth}/${theme}/search and selected filter retain exact state`);
                await search.fill(''); await filter.selectOption('');
            }
            await p.setViewportSize({ width, height: 844 });
        }
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
        check(await p.locator('.lg-collection-pane').getByRole('button', { name: '导入模型', exact: true }).count() === 0, `${width}/${theme}/connection task does not expose parallel model import`);
        check(await p.locator('.lg-collection-facts').getByText(provider.apiUrl, { exact: true }).isVisible(), `${width}/${theme}/full endpoint remains directly available in connection details`);
        check((await p.locator('.lg-collection-facts').innerText()).includes('已配置'), `${width}/${theme}/normal key state remains in connection details`);
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
        mode = 'attention';
        await ready();
        await measure('attention');
        for (const text of ['通讯密钥无法读取', '未配置 API 地址', '1 个未关联', '余额或额度不足', '配置更新前的记录', '历史结果，非实时余额']) check(await firstProvider.getByText(text, { exact: true }).isVisible(), `${width}/${theme}/attention remains visible: ${text}`);
        check(await firstProvider.getByText(/^待导入(平台)?$/).isVisible(), `${width}/${theme}/legacy configuration remains visibly pending import`);
        check(await firstProvider.locator('time').isVisible() && await firstProvider.getByRole('link', { name: '查看失败请求', exact: true }).isVisible(), `${width}/${theme}/historical failure keeps time and direct recovery`);
        check(await p.getByText('通讯密钥未配置', { exact: true }).isVisible(), `${width}/${theme}/missing key remains visible`);
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
