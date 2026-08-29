import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleOf } from '../../.claude/skills/design-replication/scripts/spec-export.mjs';
import { diffSpecs } from '../../.claude/skills/design-replication/scripts/spec-diff.mjs';

/**
 * 固化规格的两处判断：导出时留哪些档位、比对时报哪些变化。
 *
 * 它们坏掉都是静默的：导出留太多 → diff 全是噪音，人不看了；报得太少 → 改版少报一类变化，
 * 而「少报」在输出里长得跟「没变」一模一样。
 */

const board = (id, label, scales) => ({ id, label, scales });
const spec = (...boards) => ({ boards });

test('低于阈值的偶发值不进规格（浏览器默认值、一次性微调不是设计档）', () => {
  const out = scaleOf({ radius: [{ value: '11px', count: 9 }, { value: '3px', count: 1 }] }, 2);
  assert.deepEqual(out.radius.map((r) => r.value), ['11px']);
});

test('阈值可调，且是「大于等于」', () => {
  const counts = { radius: [{ value: 'a', count: 2 }, { value: 'b', count: 3 }] };
  assert.equal(scaleOf(counts, 2).radius.length, 2);
  assert.equal(scaleOf(counts, 3).radius.length, 1);
});

test('sample 不进规格：它跨次导出不稳定，留着 diff 全是噪音', () => {
  const out = scaleOf({ radius: [{ value: '11px', count: 9, sample: 'div.card' }] }, 2);
  assert.deepEqual(Object.keys(out.radius[0]).sort(), ['count', 'value']);
});

test('整个维度都被过滤掉时不留空数组（空维度会让 diff 报一堆无意义的「新增维度」）', () => {
  const out = scaleOf({ radius: [{ value: 'x', count: 1 }] }, 2);
  assert.equal(out.radius, undefined);
});

test('认得出新增与消失的档位', () => {
  const a = spec(board('b1', '屏1', { dark: { radius: [{ value: '5px', count: 4 }] } }));
  const b = spec(board('b1', '屏1', { dark: { radius: [{ value: '14px', count: 4 }] } }));
  const lines = diffSpecs(a, b);
  assert.ok(lines.some((l) => l.includes('新增：14px')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('不再出现：5px')), lines.join('\n'));
});

test('只是次数变了不算变化——元素多几个少几个是常态，报出来只会淹掉真变化', () => {
  const a = spec(board('b1', '屏1', { dark: { radius: [{ value: '11px', count: 9 }] } }));
  const b = spec(board('b1', '屏1', { dark: { radius: [{ value: '11px', count: 21 }] } }));
  assert.deepEqual(diffSpecs(a, b), []);
});

test('新增屏与删除屏都要报，且删除那条要提醒「可能是这次没量」', () => {
  const a = spec(board('b1', '屏1', { dark: {} }));
  const b = spec(board('b1', '屏1', { dark: {} }), board('b2', '屏2', { dark: {} }));
  assert.ok(diffSpecs(a, b).some((l) => l.startsWith('[新增屏]')));
  const back = diffSpecs(b, a);
  assert.ok(back.some((l) => l.startsWith('[删除屏]')));
  assert.ok(back.some((l) => l.includes('这次没量')), '删除屏必须提醒可能是漏量，否则会被当成稿子删了');
});

test('改名要报——同一个 id 换了含义，比档位变化更该被看见', () => {
  const a = spec(board('b1', '屏1主控台', { dark: {} }));
  const b = spec(board('b1', '屏1分享档', { dark: {} }));
  assert.ok(diffSpecs(a, b).some((l) => l.startsWith('[改名]')));
});

test('少一整套主题要报，不能因为深色没变就说「一致」', () => {
  const a = spec(board('b1', '屏1', { dark: {}, light: { radius: [{ value: '11px', count: 3 }] } }));
  const b = spec(board('b1', '屏1', { dark: {} }));
  assert.ok(diffSpecs(a, b).some((l) => l.startsWith('[缺主题]')));
});

test('--dims 只看指定维度时，别的维度的变化不该混进来', () => {
  const a = spec(board('b1', '屏1', { dark: { radius: [{ value: '5px', count: 3 }], fontSize: [{ value: '13px', count: 9 }] } }));
  const b = spec(board('b1', '屏1', { dark: { radius: [{ value: '5px', count: 3 }], fontSize: [{ value: '14px', count: 9 }] } }));
  assert.deepEqual(diffSpecs(a, b, ['radius']), []);
  assert.equal(diffSpecs(a, b, ['fontSize']).length, 2);
});

test('完全一致时返回空，不返回「无变化」这类需要再解析的字符串', () => {
  const a = spec(board('b1', '屏1', { dark: { radius: [{ value: '11px', count: 9 }] } }));
  assert.deepEqual(diffSpecs(a, structuredClone(a)), []);
});

test('import 这两个脚本不会顺带跑 CLI（跑了会因为缺参数直接 exit，把测试进程带走）', () => {
  // 能走到这一行本身就是断言：上面的 import 若触发了 CLI 分支，进程早就退出了
  assert.equal(typeof scaleOf, 'function');
  assert.equal(typeof diffSpecs, 'function');
});
