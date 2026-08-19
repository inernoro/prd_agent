import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { evaluateExemption } from '../../scripts/resolve-audit-exemption.mjs';

const COMPLETE = {
  exempt: true,
  reason: '观测点没有 IPv6 出网能力',
  decidedBy: 'someone',
  decidedAt: '2026-08-18',
  reviewBy: '2027-02-18',
  residualRisk: '该面未经扫描证明',
};

const registryWith = (entry: unknown) => ({ ipv6: { cds: entry } });

describe('external audit exemption registry', () => {
  it('honours a complete, unexpired registration', () => {
    const r = evaluateExemption(registryWith(COMPLETE), 'ipv6', 'cds', '2026-12-01');
    expect(r.exempt).toBe(true);
    expect(r.status).toBe('active');
  });

  it('does not treat an unregistered environment as exempt', () => {
    const r = evaluateExemption(registryWith(COMPLETE), 'ipv6', 'production', '2026-12-01');
    expect(r.exempt).toBe(false);
    expect(r.status).toBe('not-registered');
  });

  // 半条豁免比没有豁免更危险：它看着像有人决定过，实际没人说得清为什么、谁定的、什么时候复审。
  it.each(['reason', 'decidedBy', 'decidedAt', 'reviewBy', 'residualRisk'])(
    'refuses an exemption missing %s',
    (field) => {
      const entry: Record<string, unknown> = { ...COMPLETE };
      delete entry[field];
      const r = evaluateExemption(registryWith(entry), 'ipv6', 'cds', '2026-12-01');
      expect(r.exempt).toBe(false);
      expect(r.status).toBe('incomplete');
    },
  );

  it('refuses an exemption whose fields are present but blank', () => {
    const r = evaluateExemption(registryWith({ ...COMPLETE, reason: '   ' }), 'ipv6', 'cds', '2026-12-01');
    expect(r.exempt).toBe(false);
  });

  // 到期即失效——临时决定不许无声变成永久盲区。
  it('expires the exemption once reviewBy has passed', () => {
    const r = evaluateExemption(registryWith(COMPLETE), 'ipv6', 'cds', '2027-02-19');
    expect(r.exempt).toBe(false);
    expect(r.status).toBe('expired');
  });

  it('still honours it on the review date itself', () => {
    expect(evaluateExemption(registryWith(COMPLETE), 'ipv6', 'cds', '2027-02-18').exempt).toBe(true);
  });

  it('ignores an entry that never set exempt to true', () => {
    const r = evaluateExemption(registryWith({ ...COMPLETE, exempt: false }), 'ipv6', 'cds', '2026-12-01');
    expect(r.exempt).toBe(false);
    expect(r.status).toBe('not-registered');
  });

  // 真实登记必须是完整形状。这里只查结构，不查是否过期——过期该由每日巡检变红来提醒，
  // 而不是让全仓库的 CI 在某一天突然红掉。
  it('ships a structurally complete registry', () => {
    const registry = JSON.parse(
      readFileSync(new URL('../../config/external-audit-exemptions.json', import.meta.url), 'utf8'),
    );
    for (const environment of ['cds', 'production']) {
      const r = evaluateExemption(registry, 'ipv6', environment, registry.ipv6[environment].decidedAt);
      expect(r.status, `${environment} 的豁免登记不完整`).toBe('active');
    }
  });
});

describe('audit workflow wires the exemption in', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/cds-external-port-audit.yml', import.meta.url),
    'utf8',
  );

  // 豁免只允许短路 IPv6：IPv4 侧还在真扫，不该被这套机制碰到。
  it('gates every ipv6 scan step on the exemption, and leaves ipv4 alone', () => {
    const ipv6Job = workflow.slice(workflow.indexOf('  audit-ipv6:'));
    const ipv4Job = workflow.slice(workflow.indexOf('  audit-ipv4:'), workflow.indexOf('  audit-ipv6:'));

    // 窗口必须切到**下一个步骤开始处**，不能用固定字符数：定窗会溢出到下一步，
    // 于是把下一步的 if: 删掉这条断言依旧绿——守卫看着在守四步，实际只守得住前几步。
    const stepStarts = [...ipv6Job.matchAll(/^      - name: (.+)$/gm)].map((m) => ({ at: m.index ?? 0, name: m[1].trim() }));
    for (const step of ['Verify this runner can originate IPv6', 'Require off-host IPv6 target', 'Install scanner', 'Scan IPv6 from GitHub runner']) {
      const idx = stepStarts.findIndex((s) => s.name === step);
      expect(idx, `找不到步骤 ${step}`).toBeGreaterThan(-1);
      const body = ipv6Job.slice(stepStarts[idx].at, stepStarts[idx + 1]?.at ?? ipv6Job.length);
      expect(body, `${step} 没有挂豁免开关`).toContain("if: steps.exemption.outputs.exempt != 'true'");
    }
    expect(ipv4Job).not.toContain('exemption');
  });

  // 守卫自己要被触发：改了登记或解析器却不重跑巡检，等于这套机制没接上线。
  // 必须只在 on.push.paths 这一段里找——两个路径在步骤的 run: 命令里也各出现一次，
  // 对整份 workflow 做 toContain，把它们从 paths 删掉这条断言仍然绿。
  it('re-runs the audit when the registry or its resolver changes', () => {
    const pushPaths = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  workflow_dispatch:'));
    expect(pushPaths, 'on.push.paths 没解析出来').toContain('paths:');
    expect(pushPaths).toContain('cds/config/external-audit-exemptions.json');
    expect(pushPaths).toContain('cds/scripts/resolve-audit-exemption.mjs');
  });

  // 本文件自己也得跑得到。cds.yml 的 paths filter 只覆盖 cds/**，
  // 只改 cds-external-port-audit.yml（比如把四个豁免开关全删掉）的 PR 会整个跳过测试 job。
  it('is actually run by CI when only the audited workflow changes', () => {
    const ci = readFileSync(new URL('../../../.github/workflows/cds.yml', import.meta.url), 'utf8');
    expect(ci, 'cds CI 的 paths filter 必须覆盖被守的巡检工作流，否则只改它的 PR 不跑这些守卫')
      .toContain('.github/workflows/cds-external-port-audit.yml');
  });
});

// 债务 ID 撞号在这条链路上已经发生两次：先是 E34 与 redis 备份撞，改成 E35 又和
// redis 恢复撞——而 workflow 里那两句「处置见 E35」就静默指到了另一条债务上。
// 靠人眼挑下一个空号挑不准，用守卫钉死。
describe('debt ledger IDs', () => {
  it('has no duplicate E-numbers', () => {
    const ledger = readFileSync(new URL('../../../doc/debt.cds.md', import.meta.url), 'utf8');
    const ids = [...ledger.matchAll(/^\| (E\d+) \|/gm)].map((m) => m[1]);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect([...new Set(dup)], '债务台账出现重号，指向它的引用会落到错的那一条').toEqual([]);
  });

  it('every debt ID referenced from code or workflows exists in the ledger', () => {
    const ledger = readFileSync(new URL('../../../doc/debt.cds.md', import.meta.url), 'utf8');
    const known = new Set([...ledger.matchAll(/^\| (E\d+) \|/gm)].map((m) => m[1]));
    const workflow2 = readFileSync(
      new URL('../../../.github/workflows/cds-external-port-audit.yml', import.meta.url),
      'utf8',
    );
    const referenced = [...workflow2.matchAll(/debt\.cds\.md 的 (E\d+)/g)].map((m) => m[1]);
    expect(referenced.length, '这份 workflow 本来就该指向债务台账').toBeGreaterThan(0);
    for (const id of referenced) expect(known.has(id), `workflow 指向了不存在的债务 ${id}`).toBe(true);
  });
});
