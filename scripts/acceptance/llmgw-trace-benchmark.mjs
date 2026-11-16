// 同一授权浏览器会话下，对固定业务 Run 做只读查询基准。不发送模型请求，不保存正文或会话。
// node scripts/acceptance/llmgw-trace-benchmark.mjs --base-url <控制台入口> --storage-state <私有会话文件>
//   --reference <Run ID> --mode before|after --from <ISO时间> --to <ISO时间> --output <报告.json>
// after 可加 --baseline <before报告.json>，记录集合不一致时拒绝比较。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), values[index + 1]]);
  return pairs;
}, []));
for (const key of ['base-url', 'storage-state', 'reference', 'mode', 'from', 'to', 'output']) {
  if (!args[key]) throw new Error(`缺少 --${key}`);
}
if (!['before', 'after'].includes(args.mode)) throw new Error('mode 只接受 before / after');
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH || require.resolve('@playwright/test', { paths: [path.join(root, 'e2e')] });
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  const context = await browser.newContext({ storageState: args['storage-state'] });
  const page = await context.newPage();
  await page.goto(args['base-url'], { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ reference, mode, from, to, prefix }) => {
    const token = localStorage.getItem('llmgw.token');
    if (!token) throw new Error('需要从正常登录取得的 Gateway 会话，未注入或伪造身份');
    const samples = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      const start = performance.now();
      let requests = 0, attempts = 0, pageNumber = 1;
      const ids = [];
      async function read(route, query) {
        const url = prefix + route + (query ? '?' + new URLSearchParams(query) : '');
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
        requests++;
        if (!response.ok) throw new Error(`只读查询 HTTP ${response.status}`);
        const body = await response.json();
        if (!body.success) throw new Error(body.error?.code || 'QUERY_FAILED');
        return body.data;
      }
      while (true) {
        let data;
        if (mode === 'before') {
          data = await read('/gw/logs', { runId: reference, from, to, view: 'physical', page: String(pageNumber), pageSize: '500' });
          for (const row of data.items) {
            const detail = await read('/gw/logs/' + encodeURIComponent(row.id));
            ids.push(detail.id);
            attempts += (detail.providerAttempts || []).filter(item => item.reachedProvider === true).length;
          }
        } else {
          data = await read('/gw/logs/trace', { reference, page: String(pageNumber) });
          if (data.ambiguous) throw new Error('编号对应独立请求，请使用明确的业务 Run ID');
          for (const item of data.items) {
            ids.push(item.log.id);
            attempts += item.attempts.filter(attempt => attempt.reachedProvider === true).length;
          }
        }
        if (ids.length >= data.total) break;
        if (!data.items.length) throw new Error('分页未返回完整记录');
        pageNumber++;
      }
      if (!ids.length) throw new Error('案例为空，不能声称排查成本降低');
      samples.push({ requests, records: ids.length, recordedUpstreamAttempts: attempts,
        milliseconds: Math.round(performance.now() - start), ids: ids.sort() });
    }
    return { samples };
  }, { reference: args.reference, mode: args.mode, from: args.from, to: args.to,
    prefix: new URL(args['base-url']).pathname.replace(/\/$/, '') });
  for (const sample of result.samples) {
    sample.recordSetSha256 = createHash('sha256').update(sample.ids.join('\n')).digest('hex');
    delete sample.ids;
  }
  if (new Set(result.samples.map(sample => sample.recordSetSha256)).size !== 1) throw new Error('重复测量时案例集合改变');
  result.reference = args.reference;
  result.mode = args.mode;
  result.medianMilliseconds = result.samples.map(sample => sample.milliseconds).sort((a, b) => a - b)[1];
  result.measurement = '顺序只读 HTTP 查询耗时，不含人的阅读和操作时间';
  if (args.baseline) {
    const before = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
    if (before.reference !== result.reference || before.samples[0].recordSetSha256 !== result.samples[0].recordSetSha256)
      throw new Error('改善前后的记录集合不同，拒绝生成缩短结论');
    result.baselineMedianMilliseconds = before.medianMilliseconds;
  }
  fs.writeFileSync(args.output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
