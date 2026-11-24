import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const EXTRACT = '.claude/skills/design-replication/scripts/extract-design.mjs';
const DRIFT = '.claude/skills/design-replication/scripts/fixture-drift.mjs';

test('切图必须按画板自己的横向边界裁，不能一律从 x:0 起', () => {
  const src = read(EXTRACT);

  // 并排摆放的画板纵坐标相同、横坐标不同。一律 clip x:0 + 视口宽，三张图会**逐字节相同**，
  // 却挂着三个不同画板的文件名——实测过：修之前三份 PNG 的 md5 全是 a90a4575e3，
  // 修之后是三个不同的值。文案那一半早就用 scope 修过同一个洞，切图这一半漏了。
  assert.ok(
    /clip:\s*\{\s*x:\s*b\.left/.test(src),
    'clip 的 x 不是画板量出来的 left —— 并排画板会截出三张一模一样的图',
  );
  assert.ok(!/clip:\s*\{\s*x:\s*0\s*,/.test(src), '还留着 x:0 的裁剪写法');

  // 边界得真的量出来才能用；marker 形态量不到框，必须显式退回整幅宽度而不是假装量到了
  assert.ok(/absX\s*=/.test(src), '发现阶段没有量横坐标');
  assert.ok(/x:\s*absX\(el\)/.test(src) && /w:\s*Math\.round\(el\.getBoundingClientRect\(\)\.width\)/.test(src),
    '画板没有记下 x / w，后面无从按它裁剪');
  assert.ok(/const measured\s*=/.test(src), '没有区分「量到了」与「量不到」，降级会变成静默假装');
});

test('漂移守卫在一次比对都没做成时必须判红', () => {
  const src = read(DRIFT);

  // 登录过期、页面不再请求那些端点、录制中途断掉，都会让每份 fixture 落进 unchecked
  // 而 failed 仍是 0 —— 于是守卫绿着退出，却没有任何一条真机证据。
  // 「不会红的证据比没有证据更糟」：它让下一个人以为验过了。
  assert.ok(/let compared\s*=\s*0/.test(src), '没有统计真正做成的比对次数');
  assert.ok(/compared\s*\+=\s*1/.test(src), 'compared 从来不自增，等于没统计');
  assert.ok(
    /if\s*\(compared === 0\)\s*\{[\s\S]{0,600}?process\.exit\(/.test(src),
    '零比对时没有非零退出 —— 这种绿什么都不证明',
  );

  // 判红必须排在「只看 failed」之前，否则零比对那条永远走不到
  const zeroAt = src.indexOf('if (compared === 0)');
  const failedAt = src.indexOf('if (failed)');
  assert.ok(zeroAt > 0 && failedAt > 0, '两条收尾判据都得在');
  assert.ok(zeroAt < failedAt, '零比对判据排在了 failed 之后');
});
