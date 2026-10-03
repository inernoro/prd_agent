import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DAILY_EXEMPT, EXTRA_LINES, DEEP_CHECK_MAP, deepCheckOutcome } from '../smoke/lib/daily-catalog.mjs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
// 这条守卫的全部输入。改这里就要同步 ci.yml 的 release_scripts 过滤器——最后那条 test 会核对。
const GUARD_INPUTS = [
  'scripts/smoke/daily-acceptance.mjs',
  'scripts/smoke/lib/daily-catalog.mjs',
  'scripts/smoke/lib/daily-report.mjs',
  '.claude/skills/stable-smoke/reference/business-function-catalog.json',
];

const catalog = JSON.parse(read('.claude/skills/stable-smoke/reference/business-function-catalog.json'));
const script = read('scripts/smoke/daily-acceptance.mjs');

/** 每日脚本里所有被检查覆盖到的功能线（脚本起浏览器，没法 import，只能读源码里的声明）。 */
function coveredLines() {
  const fromScript = [...script.matchAll(/featureLine:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const fromDeep = Object.values(DEEP_CHECK_MAP).map((m) => m.featureLine);
  // checkCreateMenu 里经由 one(id, featureLine, ...) 传参的那三条
  const fromOne = [...script.matchAll(/one\('[A-Z0-9-]+',\s*'([a-z-]+)'/g)].map((m) => m[1]);
  return new Set([...fromScript, ...fromDeep, ...fromOne]);
}

test('业务功能台账里每条功能线，要么每天被验，要么写明为什么不验', () => {
  // 用户的要求是「核心功能的验收不要出问题」——每日只验网页托管那一版，
  // 剩下十几条功能线没有任何每日判据，一条坏了要等 48 小时那一轮（它自己还常常没跑完）。
  // 这条守卫让「台账新加一条功能线、每日清单忘了跟」在 CI 上直接红。
  const covered = coveredLines();
  const missing = catalog.featureLines
    .map((f) => f.id)
    .filter((id) => !covered.has(id) && !DAILY_EXEMPT[id]);
  assert.deepEqual(missing, [], `这些功能线没有任何每日检查，也没写豁免理由：${missing.join(', ')}`);
});

test('豁免必须有理由、且指向台账里真实存在的功能线', () => {
  const ids = new Set(catalog.featureLines.map((f) => f.id));
  for (const [id, why] of Object.entries(DAILY_EXEMPT)) {
    assert.ok(ids.has(id), `豁免了一条台账里不存在的功能线：${id}`);
    assert.ok(why && why.length >= 15, `${id} 的豁免理由太短，读的人看不出由谁来验`);
    assert.ok(!coveredLines().has(id), `${id} 既被豁免又有每日检查——二选一，不然报告里它永远显示「不在每日范围」之外的状态`);
  }
});

test('台账外的功能线不许与台账重名，且必须真的有检查', () => {
  const ids = new Set(catalog.featureLines.map((f) => f.id));
  const covered = coveredLines();
  for (const x of EXTRA_LINES) {
    assert.ok(!ids.has(x.id), `${x.id} 已经在台账里了，别在 EXTRA_LINES 里再写一份`);
    assert.ok(covered.has(x.id), `${x.id} 列为每日功能线，却没有任何检查挂在它上面`);
  }
  // 反过来：脚本里出现的每条功能线都必须能被报告认出来（否则 summarize 会在运行时拒收）
  const known = new Set([...ids, ...EXTRA_LINES.map((x) => x.id), 'environment']);
  const stray = [...covered].filter((id) => !known.has(id));
  assert.deepEqual(stray, [], `脚本里挂了报告不认识的功能线：${stray.join(', ')}`);
});

test('后端自检的结论按服务自己说的来，不替它降级（真执行）', () => {
  // 服务说 fail 就是 fail
  assert.equal(deepCheckOutcome('model-catalog:selector-runtime-contract', { status: 'fail', output: '失配' }).status, 'fail');
  // 普通 warn 要显示成「需关注」，不能吞掉
  assert.equal(deepCheckOutcome('mongo:required-indexes', { status: 'warn', output: '缺 5 条' }).status, 'warn');
  // 只有「没流量、证明不了」那几项的 warn 才按正常显示，且原话照样带出
  const quiet = deepCheckOutcome('visual-image:requests', { status: 'warn', output: '最近没有调用', observedValue: 0 });
  assert.equal(quiet.status, 'pass');
  assert.equal(quiet.observed, '最近没有调用');
  // 有样本时的 warn 不能压：耗时真超预算就是需关注（Codex 在 PR #1655 指出）
  assert.equal(deepCheckOutcome('visual-image:latency', { status: 'warn', output: '耗时超预算', observedValue: 98000 }).status, 'warn');
  // 服务新申报、这里没登记的项不能被丢掉：归到后端运行健康，结论照搬
  const unknown = deepCheckOutcome('brand-new:check', { status: 'fail', output: '新判据报红' });
  assert.equal(unknown.featureLine, 'platform-runtime');
  assert.equal(unknown.status, 'fail');
  assert.ok(unknown.next, '新申报项也必须带下一步');
  // 自检没给状态 = 没验成，不是通过
  assert.equal(deepCheckOutcome('db:roundtrip', {}).status, 'not-run');
  // 已登记的项在自检里整个消失（改名 / 删除）：必须是「未执行」且说清是消失了，不许静默跳过
  const gone = deepCheckOutcome('model-catalog:selector-runtime-contract', undefined);
  assert.equal(gone.status, 'not-run');
  assert.match(gone.observed, /没有这一项/);
  assert.equal(gone.featureLine, 'llm-gateway');
});

test('知识库「+」只许单击：双击会直接开始录音、去要麦克风权限', () => {
  const fn = script.slice(script.indexOf('async function checkCreateMenu'), script.indexOf('async function runApiChecks'));
  assert.ok(fn.length > 200, '没找到 checkCreateMenu');
  assert.ok(!/dblclick|clickCount:\s*2/.test(fn), 'checkCreateMenu 里出现了双击');
  // 遮挡判定必须在点击之前：先问命中测试，再按下
  assert.ok(fn.indexOf('elementFromPoint') < fn.indexOf('page.mouse.down'), '遮挡判定排在了点击之后');
});

test('守卫自己必须接在闸上（每个输入都登记进 CI 过滤器）', () => {
  const ci = read('.github/workflows/ci.yml');
  const block = ci.slice(ci.indexOf('            release_scripts:'), ci.indexOf('            acceptance_report:'));
  assert.ok(block.length > 200, 'release_scripts 过滤器没解析出来');
  const patterns = [...block.matchAll(/^\s*- '([^']+)'/gm)].map((m) => m[1]);
  const covers = (pattern, file) => new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*') + '$',
  ).test(file);
  const missing = GUARD_INPUTS.filter((f) => !patterns.some((p) => covers(p, f)));
  assert.deepEqual(missing, [], `这些被守文件没登记进 release_scripts 过滤器：${missing.join(', ')}`);
});

test('主脚本会把「已登记但自检里缺席」的项补登为未执行', () => {
  // Codex 在 PR #1655 指出：只遍历自检返回的键，删掉一项就从报告里静默消失
  const fn = script.slice(script.indexOf('async function checkDeepHealth'), script.indexOf('function checkStableSmokeFreshness'));
  assert.match(fn, /Object\.keys\(DEEP_CHECK_MAP\)/, 'checkDeepHealth 没有遍历已登记的自检项');
  assert.match(fn, /deepCheckOutcome\(key, undefined\)/, '缺席的已登记项没有被补登');
});

test('要求归档却没归档成，退出码不能是 0', () => {
  // Codex 在 PR #1655 指出：归档失败时照样 exit 0，计划任务会当成成功、证据丢失
  assert.match(script, /if \(ARCHIVE && !reportUrl && exitCode === 0\) exitCode = 1;/);
});

test('深度自检整体打不通时，已登记的每一项都落表为未执行', () => {
  // Codex 在 PR #1655 指出：整体失败那条路径提前 return，已登记项全部消失
  const down = deepCheckOutcome('model-catalog:selector-runtime-contract', undefined, { endpointDown: true });
  assert.equal(down.status, 'not-run');
  assert.match(down.observed, /整体没有给出结论/);
  const fn = script.slice(script.indexOf('async function checkDeepHealth'), script.indexOf('function checkStableSmokeFreshness'));
  const earlyReturn = fn.slice(0, fn.indexOf('return null;'));
  assert.match(earlyReturn, /deepCheckOutcome\(key, undefined, \{ endpointDown: true \}\)/, '整体失败路径没有逐项补登');
});

test('一个检查整体抛异常时，它名下的每一项都记失败；主流程结束前统一补齐没跑到的项', () => {
  // Codex 在 PR #1655 指出：知识库「+」检查抛异常只记了录音一项，其余三项成了没原因的空行
  assert.match(script, /await guard\(CREATE_MENU_RESULTS, \(\) => checkCreateMenu\(ctx\)\)/);
  const ids = [...script.slice(script.indexOf('const CREATE_MENU_RESULTS'), script.indexOf('/** 只读接口')).matchAll(/id: '([A-Z0-9-]+)'/g)].map((m) => m[1]);
  const menu = script.slice(script.indexOf('async function checkCreateMenu'), script.indexOf('const CREATE_MENU_RESULTS'));
  const produced = [...menu.matchAll(/(?:id: |one\()'([A-Z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), [...new Set(produced)].sort(), 'CREATE_MENU_RESULTS 与 checkCreateMenu 实际产出的项不一致');
  // 兜底调用必须在 try/finally 之后、无条件执行
  const tail = script.slice(script.indexOf('// ── 主流程 ──'));
  const finallyEnd = tail.indexOf('if (browser) await browser.close()');
  assert.ok(tail.indexOf("markRemainingNotRun('本轮检查中途中断") > finallyEnd, '主流程之后缺少无条件兜底补登');
});

test('48 小时冒烟心跳只认运行器自己的标题格式', () => {
  const fn = script.slice(script.indexOf('function checkStableSmokeFreshness'), script.indexOf('async function checkEnvironment'));
  const rx = new RegExp(fn.match(/\.filter\(\(x\) => \/(.+?)\/\.test/)[1]);
  assert.ok(rx.test('核心业务稳定冒烟 stsmk-20261002-1019-3a7aab'));
  assert.ok(!rx.test('发布验收 · 核心业务稳定冒烟 · 2026-09-30'), '发布验收报告不是 48 小时心跳');
  assert.ok(!rx.test('功能验收 · 核心业务稳定冒烟失败取证 · 2026-09-14'));
});
