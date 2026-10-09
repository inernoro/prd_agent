import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { outcome, summarize, renderMarkdown, renderHtml, headline, archiveTitle } from '../smoke/lib/daily-report.mjs';

const catalog = JSON.parse(readFileSync(
  new URL('../../.claude/skills/stable-smoke/reference/business-function-catalog.json', import.meta.url), 'utf8',
));

const ok = (id, line) => outcome({ id, featureLine: line, title: `检查 ${id}`, method: '打开页面', status: 'pass', observed: '看到了' });

test('判为异常或未执行却不写下一步，报告直接造不出来', () => {
  // 这条是整份报告的价值所在：一行「失败」不带下一步，读的人只能自己猜该干嘛。
  // 用类型（构造器抛错）而不是事后抽查文案来保证（external-cause-first 第四节）。
  assert.throws(() => outcome({ id: 'X', featureLine: 'recording', title: 't', method: 'm', status: 'fail', observed: '坏了' }), /下一步/);
  assert.throws(() => outcome({ id: 'X', featureLine: 'recording', title: 't', method: 'm', status: 'not-run' }), /下一步/);
  assert.throws(() => outcome({ id: 'X', featureLine: 'recording', title: 't', method: 'm', status: 'warn' }), /下一步/);
  assert.throws(() => outcome({ id: 'X', featureLine: 'recording', title: 't', method: 'm', status: 'unknown', next: 'x' }), /未知状态/);
  assert.equal(outcome({ id: 'X', featureLine: 'recording', title: 't', method: 'm', status: 'fail', next: '查日志' }).next, '查日志');
});

test('功能线取最坏的那一条，异常排在最前，豁免的排在最后', () => {
  const results = [
    ok('A', 'web-hosting-sharing'),
    outcome({ id: 'B', featureLine: 'web-hosting-sharing', title: '分享页', method: 'm', status: 'fail', observed: 'iframe 空白', next: '查 COS' }),
    ok('C', 'visual-creation'),
    outcome({ id: 'D', featureLine: 'recording', title: '入口', method: 'm', status: 'not-run', observed: '前置失败', next: '重跑' }),
  ];
  const s = summarize({ results, catalog, exempt: { 'release-recovery': '交给 48 小时' }, base: 'https://x', at: '2026-10-03T00:00:00Z' });
  assert.equal(s.lines[0].id, 'web-hosting-sharing');
  assert.equal(s.lines[0].status, 'fail');
  assert.equal(s.lines.at(-1).status, 'exempt');
  assert.equal(s.verdict, 'fail');
  // 台账里没有结果、也没豁免的功能线必须显示「未执行」，不许被悄悄略过
  const lit = s.lines.find((l) => l.id === 'literary-creation');
  assert.equal(lit.status, 'not-run');
  assert.match(headline(s), /异常：网页托管与分享/);
});

test('挂在台账之外的功能线上的结果会被拒收', () => {
  // 防止每日清单和业务功能台账悄悄分叉成两份功能清单（判据分裂，形状 3）
  assert.throws(() => summarize({ results: [ok('A', 'no-such-line')], catalog, base: 'x', at: 'x' }), /不存在的功能线/);
});

test('被测环境不可达时，结论第一句就说环境，不说功能', () => {
  const env = outcome({ id: 'ENV', featureLine: 'environment', title: '被测环境可达', method: 'curl', status: 'fail', observed: '首页 HTTP 503', next: '去 CDS 重新部署 main', fatal: true });
  const s = summarize({ results: [env], catalog, base: 'x', at: '2026-10-03T00:00:00Z' });
  assert.equal(s.verdict, 'fail');
  assert.match(headline(s), /^被测环境本身不可用/);
  assert.match(renderMarkdown(s), /去 CDS 重新部署 main/);
});

test('渲染产物：Markdown 一行一条功能线，HTML 不含 emoji 且转义', () => {
  const results = [ok('A', 'web-hosting-sharing'),
    outcome({ id: 'B', featureLine: 'llm-gateway', title: '<模型池>', method: 'm', status: 'fail', observed: 'a|b', next: '配模型' })];
  const s = summarize({ results, catalog, base: 'https://x', at: '2026-10-03T00:00:00Z' });
  const md = renderMarkdown(s);
  const rows = md.split('\n').filter((l) => /^\| (正常|异常|未执行|需关注|不在每日范围) \|/.test(l));
  assert.equal(rows.length, catalog.featureLines.length);
  assert.match(md, /a\\\|b/);
  const html = renderHtml(s);
  assert.ok(html.includes('&lt;模型池&gt;'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html + md), '报告里出现了 emoji');
});

test('归档用的完整版：每一项检查都在明细里，异常项带截图，短版不带', () => {
  const shot = 'data:image/jpeg;base64,AAAA';
  const results = [
    ok('A', 'web-hosting-sharing'),
    outcome({ id: 'B', featureLine: 'knowledge-assets', title: '入口被盖住', method: 'm', status: 'warn', observed: '被提醒浮窗盖住', next: '挪开浮窗', shot }),
    outcome({ id: 'E', featureLine: 'environment', title: '被测环境可达', method: 'm', status: 'pass', observed: '200' }),
  ];
  const s = summarize({ results, catalog, base: 'https://x', at: '2026-10-03T00:00:00Z' });
  const full = renderMarkdown(s, { full: true });
  const detail = full.slice(full.indexOf('### 逐项明细'));
  for (const r of results) assert.ok(detail.includes(r.title), `明细里漏了「${r.title}」`);
  assert.ok(full.includes(shot), '需关注项的截图没进完整版');
  assert.ok(!renderMarkdown(s).includes(shot), '短版（推送用）不该带截图');
  // 归档版状态带颜色徽标，但文字仍在（色弱 / 纯文本渲染也读得出）；短版保持纯文本
  assert.match(full, /<span style="[^"]*">需关注<\/span>/);
  assert.ok(!renderMarkdown(s).includes('<span'), '短版不该带 HTML');
});

test('非致命前置项失败（如对象存储）时，不许说「都没能验」，其余结果照常进结论', () => {
  // Codex 在 PR #1655 指出：对象存储失败时其余检查照样跑了，首句却说全都没验，和表格自相矛盾
  const results = [
    outcome({ id: 'ENV-01', featureLine: 'environment', title: '被测环境可达', method: 'm', status: 'pass', fatal: true }),
    outcome({ id: 'ENV-02', featureLine: 'environment', title: '对象存储读写就绪', method: 'm', status: 'fail', observed: '存储未就绪', next: '查桶' }),
    ok('A', 'web-hosting-sharing'),
  ];
  const s = summarize({ results, catalog, base: 'x', at: '2026-10-03T00:00:00Z' });
  assert.equal(s.verdict, 'fail');
  assert.doesNotMatch(headline(s), /都没能验/);
  assert.match(headline(s), /前置项有问题：对象存储读写就绪/);
  // 非 environment 的结果即便传了 fatal 也不算致命
  assert.equal(outcome({ id: 'X', featureLine: 'recording', title: 't', method: 'm', status: 'pass', fatal: true }).fatal, false);
});

test('归档标题和结论一致：环境不可达时不许写成「0 条功能线异常」', () => {
  const env = outcome({ id: 'ENV-01', featureLine: 'environment', title: '被测环境可达', method: 'm', status: 'fail', observed: '503', next: '重新部署', fatal: true });
  const down = summarize({ results: [env], catalog, exempt: { 'release-recovery': '交给发布门禁验证，每日不触发发布' }, base: 'x', at: '2026-10-03T00:00:00Z' });
  assert.match(archiveTitle(down), /被测环境不可用/);
  assert.doesNotMatch(archiveTitle(down), /0 条功能线异常/);
  const bad = summarize({ results: [outcome({ id: 'B', featureLine: 'llm-gateway', title: 't', method: 'm', status: 'fail', next: 'n' })], catalog, base: 'x', at: '2026-10-03T00:00:00Z' });
  assert.match(archiveTitle(bad), /1 条功能线异常/);
});

test('环境不可达时，首句写实际没验成的条数，不把独立验过的那一行也算进去', () => {
  const env = outcome({ id: 'ENV-01', featureLine: 'environment', title: '被测环境可达', method: 'm', status: 'fail', observed: '503', next: '重新部署', fatal: true });
  const stable = outcome({ id: 'S', featureLine: 'stability-foundation', title: '心跳', method: 'm', status: 'pass' });
  const s = summarize({ results: [env, stable], catalog, base: 'x', at: '2026-10-03T00:00:00Z' });
  assert.match(headline(s), new RegExp(`^被测环境本身不可用，${s.counts.notRun} 条核心功能没能验`));
  assert.ok(s.counts.notRun < s.counts.lines);
});

test('动态文本里的 HTML 与链接语法在两版 Markdown 里都被转义，可信徽标保持原样', () => {
  // Codex 在 PR #1655 指出：CDS 用 marked 把归档报告渲染进允许脚本的 iframe，原样透传就是存储型 XSS
  const evil = '<script>alert(1)</script> [点我](javascript:alert(1))';
  const results = [outcome({ id: 'X', featureLine: 'identity-access', title: evil, method: evil, status: 'fail', observed: evil, next: evil, shot: 'data:image/jpeg;base64,AAAA' })];
  const s = summarize({ results, catalog, base: 'x', at: '2026-10-03T00:00:00Z' });
  for (const md of [renderMarkdown(s), renderMarkdown(s, { full: true })]) {
    assert.ok(!md.includes('<script'), '出现了未转义的 <script>');
    assert.ok(!md.includes('](javascript:'), '动态文本拼出了可点击的 javascript: 链接');
    assert.ok(md.includes('&lt;script&gt;'), '转义后的文本应当仍然可读');
  }
  assert.match(renderMarkdown(s, { full: true }), /<span style="[^"]*">异常<\/span>/, '可信徽标被误转义了');
});
