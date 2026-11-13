// Deterministic layout evidence only; API fixtures do not prove live integrations.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
const base = process.argv[2] || 'http://127.0.0.1:8873';
const label = process.argv[3] || 'after';
const verify = !process.argv.includes('--measure-only');
const out = path.resolve(process.env.CDS_DENSITY_EVIDENCE || 'work/content-density');
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
const result = [];
try {
    for (const width of (process.env.DENSITY_WIDTH ? [Number(process.env.DENSITY_WIDTH)] : [1440, 390]))
        for (const theme of ['light', 'dark']) {
            const p = await b.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
            let count = 2, connectionCount = 2, configured = true, fail = false;
            const unexpected = new Set();
            const errors = [];
            const reports = () => Array.from({ length: count }, (_, i) => ({ id: `report-${i}`, title: `功能验收 样例 ${String(i + 1).padStart(2, '0')}`, format: 'markdown', verdict: 'pass', content: '# 测试报告\n验收证据内容。', projectId: null, createdAt: new Date(Date.UTC(2026, 10, 13, 10, i)).toISOString(), updatedAt: '2026-11-13T10:00:00Z', classification: { categories: ['availability'], primarySystem: 'cds', relatedSystems: [], environments: ['test'] } }));
            const funnel = { changes: 4, deployed: 3, accepted: 2, merged: 1, pass: 2, conditional: 0, fail: 0, undetermined: 0 };
            const leaks = { 'deployed-not-accepted': 1, 'merged-not-accepted': 0, 'merged-while-failing': 0, 'report-missing-change-key': 0 };
            const pipeline = { generatedAt: '2026-11-13T10:00:00Z', recentDays: 7, total: funnel, totalLeaks: leaks, projects: [{ projectId: 'fixture-project', projectName: '样例项目', funnel, leaks, missingKinds: [], staleReports: 0, inFlight: 1, lastActivityAt: '2026-11-13T10:00:00Z', githubLinked: true }], staleReports: 0, leaks: [] };
            await p.route('**/api/**', async (r) => {
                const path = new URL(r.request().url()).pathname.replace(/^\/_cds/, '');
                let data;
                if (isEventStream(path))
                    return r.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
                if (path === '/api/reports')
                    data = { reports: reports() };
                else if (path === '/api/report-folders')
                    data = { folders: [] };
                else if (path === '/api/reports/pipeline')
                    data = { pipeline, series: { days: ['2026-11-11', '2026-11-12', '2026-11-13'], changes: [1, 2, 1], pass: [1, 0, 1], conditional: [0, 0, 0], fail: [0, 0, 0], undetermined: [0, 0, 0], projects: [{ projectId: 'fixture-project', projectName: '样例项目', counts: [1, 0, 1], total: 2 }], otherProjects: { count: 0, total: 0 }, lastDayPartial: true, deployNote: 'no-deploy-history' } };
                else if (path === '/api/reports/overview')
                    return r.fulfill({ status: 503, json: { error: '聚合暂不可用，请重试' } });
                else if (path === '/api/cds-system/connections')
                    data = { connections: Array.from({ length: connectionCount }, (_, i) => ({ id: `fixture-connection-${i}`, name: `样例长期连接 ${i + 1}`, partnerKind: 'map', status: i ? 'revoked' : 'active', scopes: ['instance:read', 'report:read'], partnerName: 'MAP 样例', partnerBaseUrl: 'https://map.example.invalid', createdAt: '2026-11-13T10:00:00Z' })) };
                else if (path === '/api/cds-system/integrations/bug-report')
                    data = { configured, source: 'system-settings', baseUrl: 'https://map.example.invalid', tokenConfigured: true, secretStorage: 'encrypted', authorizationUrl: 'https://map.example.invalid/authorize' };
                else if (path === '/api/cds-system/integrations/bug-report/test')
                    data = { ok: !fail, message: fail ? '对端暂不可达，请重试' : '验证连接成功' };
                else if (path === '/api/cds-system/connections/knowledge-bases')
                    data = { connections: [] };
                else {
                    data = resolveFixture(path);
                    if (data === null) {
                        unexpected.add(path);
                        data = {};
                        console.log('UNREGISTERED', path);
                    }
                }
                await r.fulfill({ json: data });
            });
            p.on('pageerror', e => errors.push(e.message));
            console.log('begin', label, width, theme);
            await p.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
            await p.locator('#reports-ledger tbody tr').first().waitFor();
            const ledger = await p.locator('#reports-ledger tbody tr').first().boundingBox();
            const reportMetrics = { surface: 'reports', width, theme, y: ledger.y, rowHeight: ledger.height, pagination: await p.getByRole('button', { name: '下一页', exact: true }).count(), overflow: await p.evaluate(() => document.documentElement.scrollWidth > innerWidth) };
            await p.screenshot({ path: `${out}/${label}-reports-${width}-${theme}.png` });
            result.push(reportMetrics);
            fs.writeFileSync(`${out}/${label}-measure.json`, JSON.stringify(result, null, 2));
            console.log('report-measure', reportMetrics);
            if (verify) {
                if (ledger.y > (width === 1440 ? 500 : 800))
                    throw Error('报告台账首条数据被前置包装挤出目标位置');
                if (reportMetrics.pagination !== 0)
                    throw Error('两条记录不应显示分页');
                const summary = p.locator('summary').filter({ hasText: '趋势分析' });
                await summary.focus();
                await p.keyboard.press('Enter');
                if (!(await p.locator('.tc .card').first().isVisible()))
                    throw Error('趋势展开不可见');
                await summary.click();
                count = 21;
                await p.reload({ waitUntil: 'domcontentloaded' });
                await p.locator('#reports-ledger tbody tr').first().waitFor();
                console.log('reloaded rows', width, await p.locator('#reports-ledger tbody tr').count());
                await p.screenshot({ path: `${out}/${label}-reports-many-${width}-${theme}.png` });
                await p.getByRole('button', { name: '下一页', exact: true }).click();
                if (await p.locator('#reports-ledger tbody tr').count() !== 1)
                    throw Error('大量数据分页未生效');
                count = 0;
                await p.reload({ waitUntil: 'domcontentloaded' });
                await p.getByText('还没有归档任何验收报告。上面的流水线来自分支与合并记录，不依赖台账。', { exact: true }).waitFor();
                if (await p.getByRole('button', { name: '下一页', exact: true }).count())
                    throw Error('空台账出现分页');
            }
            await p.goto(`${base}/cds-settings#connections`, { waitUntil: 'domcontentloaded' });
            await p.getByRole('heading', { name: '连接记录', exact: true }).waitFor();
            await p.locator('table tbody tr').first().waitFor();
            const row = await p.locator('table tbody tr').first().boundingBox();
            const cm = { surface: 'connections', width, theme, y: row.y, rowHeight: row.height, overflow: await p.evaluate(() => document.documentElement.scrollWidth > innerWidth) };
            result.push(cm);
            fs.writeFileSync(`${out}/${label}-measure.json`, JSON.stringify(result, null, 2));
            console.log('measure', reportMetrics, cm);
            await p.screenshot({ path: `${out}/${label}-connections-${width}-${theme}.png` });
            if (verify) {
                if (width === 1440 && row.y > 350)
                    throw Error('连接记录首条数据仍被重复包装推迟');
                if (cm.overflow || reportMetrics.overflow)
                    throw Error('全页横向溢出');
                await p.getByRole('button', { name: '验证连接', exact: true }).click();
                await p.getByText('验证连接成功', { exact: true }).waitFor();
                if (await p.locator('section [role="status"]').filter({ hasText: '验证连接成功' }).count())
                    throw Error('成功反馈不应占据记录前的文档流');
                fail = true;
                await p.getByRole('button', { name: '验证连接', exact: true }).click();
                await p.getByRole('alert').filter({ hasText: '对端暂不可达' }).waitFor();
                fail = false;
                await p.getByRole('button', { name: '验证连接', exact: true }).click();
                await p.getByText('验证连接成功', { exact: true }).waitFor();
                if (await p.getByRole('alert').filter({ hasText: '对端暂不可达' }).count())
                    throw Error('重试成功后仍残留错误');
                connectionCount = 0;
                configured = false;
                await p.reload({ waitUntil: 'domcontentloaded' });
                await p.getByText('暂无连接记录，请使用上方“前往 MAP 授权”。', { exact: true }).waitFor();
                if (!(await p.getByRole('link', { name: '前往 MAP 授权', exact: true }).isVisible()))
                    throw Error('未配置时授权入口不可见');
            }
            if (unexpected.size)
                throw Error(`Unregistered fixture paths: ${[...unexpected].join(', ')}`);
            if (errors.length)
                throw Error(`Page errors: ${errors.join('; ')}`);
            await p.close();
        }
    console.log(JSON.stringify(result));
    fs.writeFileSync(`${out}/${label}-measure.json`, JSON.stringify(result, null, 2));
}
finally {
    await b.close();
}
