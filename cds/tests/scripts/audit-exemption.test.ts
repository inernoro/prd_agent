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

    for (const step of ['Verify this runner can originate IPv6', 'Require off-host IPv6 target', 'Install scanner', 'Scan IPv6 from GitHub runner']) {
      const at = ipv6Job.indexOf(step);
      expect(at, `找不到步骤 ${step}`).toBeGreaterThan(-1);
      expect(
        ipv6Job.slice(at, at + 260),
        `${step} 没有挂豁免开关`,
      ).toContain("if: steps.exemption.outputs.exempt != 'true'");
    }
    expect(ipv4Job).not.toContain('exemption');
  });

  // 守卫自己要被触发：改了登记或解析器却不重跑巡检，等于这套机制没接上线。
  it('re-runs the audit when the registry or its resolver changes', () => {
    expect(workflow).toContain('cds/config/external-audit-exemptions.json');
    expect(workflow).toContain('cds/scripts/resolve-audit-exemption.mjs');
  });
});
