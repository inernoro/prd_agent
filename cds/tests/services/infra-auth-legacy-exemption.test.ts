import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateInfraAuthentication,
  INFRA_AUTH_GATE_LIVE_AT,
  INFRA_AUTH_GRACE_DEFAULT_UNTIL,
} from '../../src/services/infra-auth-policy.js';

/**
 * 认证门禁的存量豁免。
 *
 * 2026-08-18 的教训：门禁上线后平台立刻停摆——它装在「启动基础设施」这一步，
 * 而分支部署必然要确保依赖的库在跑，于是五个项目十几个无认证的存量库全部起不来，
 * 连主分支预览都部署失败，而那些库本身活得好好的、数据也在。
 *
 * 方向没错，错在把两件事混成一个判定：**「不许再造新的」是纪律，「立刻停掉已有的」
 * 是停机**。豁免只解开后一半，且必须带三条边界，缺一条就退化成永久赦免：
 * 只给存量、会到期、看得见。
 */

const NO_AUTH_MONGO = {
  dockerImage: 'mongo:8.0',
  id: 'mongodb',
  containerName: 'cds-infra-mongodb',
  env: {},
};
const BEFORE = '2026-08-01T00:00:00.000Z';   // 门禁上线前登记 = 存量
const AFTER = '2026-08-18T12:00:00.000Z';    // 门禁上线后登记 = 新建
const DURING_GRACE = new Date('2026-08-20T00:00:00.000Z');

describe('存量豁免', () => {
  it('配了认证的照常放行，压根不进豁免逻辑', () => {
    const d = evaluateInfraAuthentication({
      ...NO_AUTH_MONGO,
      env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'x' },
      createdAt: AFTER,
    }, { now: DURING_GRACE });
    expect(d.allowed).toBe(true);
    expect(d.exemption, '正常配了认证不该被标成豁免').toBeUndefined();
  });

  it('门禁上线后新建的无认证实例：照拦不误', () => {
    // 这一条是豁免的底线。放开它，门禁就只剩装饰。
    const d = evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt: AFTER }, { now: DURING_GRACE });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('拒绝创建无认证');
  });

  it('门禁上线前的存量库：限期放行，并带上还剩几天', () => {
    const d = evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt: BEFORE }, { now: DURING_GRACE });
    expect(d.allowed).toBe(true);
    expect(d.exemption?.daysLeft).toBeGreaterThan(0);
    expect(d.exemption?.message).toContain('到期后将无法启动');
  });

  it('豁免到期之后，存量库同样拦——这是欠条不是赦免', () => {
    const d = evaluateInfraAuthentication(
      { ...NO_AUTH_MONGO, createdAt: BEFORE },
      { now: new Date('2026-10-01T00:00:00.000Z') },
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('存量豁免已于');
  });

  it('临近到期升级为紧急，好让「该做迁移了」从日志里长出来', () => {
    const until = Date.parse(INFRA_AUTH_GRACE_DEFAULT_UNTIL);
    const near = new Date(until - 3 * 86_400_000);
    const far = new Date(until - 20 * 86_400_000);
    expect(evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt: BEFORE }, { now: near })
      .exemption?.urgent).toBe(true);
    expect(evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt: BEFORE }, { now: far })
      .exemption?.urgent).toBe(false);
  });

  it('登记时间读不出来的一律按新建处理——不确定就不放行', () => {
    for (const createdAt of [undefined, null, '', '不是时间']) {
      const d = evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt }, { now: DURING_GRACE });
      expect(d.allowed, `createdAt=${JSON.stringify(createdAt)} 不该被放行`).toBe(false);
    }
  });

  it('到期日可以被运维显式推迟，但那是一次动手的决定', () => {
    const afterDefault = new Date('2026-10-01T00:00:00.000Z');
    const denied = evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt: BEFORE }, { now: afterDefault });
    expect(denied.allowed).toBe(false);
    const extended = evaluateInfraAuthentication(
      { ...NO_AUTH_MONGO, createdAt: BEFORE },
      { now: afterDefault, graceUntil: '2026-11-01T00:00:00.000Z' },
    );
    expect(extended.allowed).toBe(true);
  });

  it('存量的判定基准就是门禁上线时刻，不是随手挑的日期', () => {
    const live = Date.parse(INFRA_AUTH_GATE_LIVE_AT);
    const justBefore = new Date(live - 1000).toISOString();
    const justAfter = new Date(live + 1000).toISOString();
    expect(evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt: justBefore }, { now: DURING_GRACE }).allowed).toBe(true);
    expect(evaluateInfraAuthentication({ ...NO_AUTH_MONGO, createdAt: justAfter }, { now: DURING_GRACE }).allowed).toBe(false);
  });
});

/** 接线守卫：豁免走了却没人记，等于把门禁删掉——那正是这次要防的形状。 */
describe('豁免必须留痕', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/services/container.ts'), 'utf8');

  it('启动路径走的是带豁免的判定，不是老的一刀切断言', () => {
    expect(SRC).toContain('evaluateInfraAuthentication(');
    expect(SRC).not.toContain('assertInfraAuthenticationConfigured(');
  });

  it('放行时记事件，且临近到期升 error', () => {
    expect(SRC).toContain("action: 'infra.auth.legacy-exemption'");
    expect(SRC).toMatch(/exemption\.urgent \? 'error' : 'warn'/);
  });

  it('判定为不允许时确实抛错，没有被顺手放过去', () => {
    expect(SRC).toMatch(/if \(!authDecision\.allowed\)[\s\S]{0,120}throw new Error/);
  });
});
