import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStableSmokeVisualEvidence } from '../../e2e/utils/stableSmokeVisualEvidence.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'finite-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plan = { runId: 'synthetic-run', commit: 'a'.repeat(40), captureStartedAt: new Date().toISOString(), slots: [1, 2].map(n => ({
    slotId: `FINITE-${n}`, environment: 'cds', primaryState: `state-${n}`, module: 'finite-tool-test',
    entryPath: '/synthetic', pageOrigin: 'https://synthetic.invalid', theme: 'dark', viewportClass: 'desktop',
    methodAnchor: 'method-finite', breadcrumb: '合成本地工具测试', coverageStates: [`state-${n}`], expectedProof: '仅证明工具合同',
  })) };
  const planPath = join(dir, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  const env = { STABLE_SMOKE_VISUAL_PLAN: planPath, STABLE_SMOKE_VISUAL_OUTPUT: join(dir, 'output'),
    STABLE_SMOKE_RUN_ID: plan.runId, STABLE_SMOKE_COMMIT: plan.commit, STABLE_SMOKE_ENVIRONMENT: 'cds' };
  let shots = 0;
  const capture = createStableSmokeVisualEvidence({ environment: env, harnessLoader: async () => ({
    box: async () => {}, clearBoxes: async () => {},
    shot: async (page, out, name, caption, meta) => {
      shots++; if (options.fail) throw Error('synthetic-capture-failed');
      const path = join(out, name + '.png'); await writeFile(path, 'synthetic-bytes-not-a-product-screenshot');
      return { ...meta, path, capturedAt: new Date().toISOString(), pageOrigin: 'https://synthetic.invalid', pagePath: '/synthetic',
        theme: 'dark', viewportClass: 'desktop', automatedStatus: options.automatedStatus || '通过' };
    },
  }) });
  const page = { url: () => 'https://synthetic.invalid/synthetic' };
  const input = n => ({ slotId: `FINITE-${n}`, overviewJustification: '本地严格替身仅验证文件账本合同' });
  return { capture, page, input, plan, planPath, env, options, shots: () => shots, manifest: join(env.STABLE_SMOKE_VISUAL_OUTPUT, 'manifest.json') };
}
test('未配置有限计划时不产生截图、不加载浏览器、不把未执行冒通过', async () => {
  const c = createStableSmokeVisualEvidence({ environment: {}, harnessLoader: () => { throw Error('must not load'); } });
  assert.deepEqual(await c(null, null, {}), { captured: false, reason: 'visual-evidence-disabled' });
});
test('真实文件账本同一证据位只拍一次，附件不重复替换历史', async t => {
  const f = await fixture(t); const a = await f.capture(f.page, null, f.input(1));
  const b = await f.capture(f.page, null, f.input(1));
  assert.equal(a.captured, true); assert.equal(b.reason, 'slot-already-captured'); assert.equal(f.shots(), 1);
  assert.equal(JSON.parse(await readFile(f.manifest)).length, 1);
});
test('不同证据位并发完成后原子合入同一账本，不相互覆盖', async t => {
  const f = await fixture(t); await Promise.all([1, 2].map(n => f.capture(f.page, null, f.input(n))));
  const rows = JSON.parse(await readFile(f.manifest)); assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(r => r.slotId)), new Set(['FINITE-1', 'FINITE-2']));
});
test('错误commit、页面来源与重复槽均在截图之前拒绝', async t => {
  const f = await fixture(t); f.env.STABLE_SMOKE_COMMIT = 'b'.repeat(40);
  await assert.rejects(f.capture(f.page, null, f.input(1)), /commit/); f.env.STABLE_SMOKE_COMMIT = f.plan.commit;
  await assert.rejects(f.capture({ url: () => 'https://other.invalid/synthetic' }, null, f.input(1)), /来源/);
  f.plan.slots.push(f.plan.slots[0]); await writeFile(f.planPath, JSON.stringify(f.plan));
  await assert.rejects(f.capture(f.page, null, f.input(1)), /数量应为 1/); assert.equal(f.shots(), 0);
});
test('替换截图失败保留之前账本和文件，失败不会冲掉最后证据', async t => {
  const f = await fixture(t); const first = await f.capture(f.page, null, f.input(1));
  const before = await readFile(f.manifest); f.options.fail = true;
  await assert.rejects(f.capture(f.page, null, { ...f.input(1), status: '不通过', failureEvidence: true, failureReason: 'synthetic failure' }), /capture-failed/);
  assert.deepEqual(await readFile(f.manifest), before); assert.ok((await readFile(first.record.path)).length > 0);
});
test('同run新commit必须新证据，旧文件保留且manifest只指向新commit', async t => {
  const f = await fixture(t); const first = await f.capture(f.page, null, f.input(1));
  f.env.STABLE_SMOKE_COMMIT = 'b'.repeat(40); f.plan.commit = f.env.STABLE_SMOKE_COMMIT;
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const current = await f.capture(f.page, null, f.input(1)); assert.notEqual(current.record.path, first.record.path);
  const rows = JSON.parse(await readFile(f.manifest)); assert.equal(rows.length, 1); assert.equal(rows[0].commit, 'b'.repeat(40));
  assert.ok((await readFile(first.record.path)).length > 0);
});
test('自动检查失败不能按通过写入账本', async t => {
  const f = await fixture(t, { automatedStatus: '不通过' });
  await assert.rejects(f.capture(f.page, null, f.input(1)), /自动检查未通过/);
  await assert.rejects(readFile(f.manifest), { code: 'ENOENT' });
});

test('同run同commit的旧记录来自其它部署域名时不能自我校验后复用', async t => {
  const f = await fixture(t); await f.capture(f.page, null, f.input(1));
  const rows = JSON.parse(await readFile(f.manifest)); rows[0].pageOrigin = 'https://previous.invalid';
  await writeFile(f.manifest, JSON.stringify(rows)); const before = await readFile(f.manifest);
  await assert.rejects(f.capture(f.page, null, f.input(1)), /pageOrigin/);
  assert.equal(f.shots(), 1); assert.deepEqual(await readFile(f.manifest), before);
});
