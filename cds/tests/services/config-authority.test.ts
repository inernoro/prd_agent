/**
 * config-authority 测试 — 2026-05-29 配置字段三级权威模型。
 *
 * 用户洞察「每个东西限制什么、不限制什么，这很重要」的落地守卫:
 * - repo 权威字段(workDir/command/image): agent + user 都能改
 * - platform 权威字段(ports/networks/域名): 只有平台能改，agent/user 强写 reject
 * - user 权威字段(environment): 用户可覆盖
 * - 未登记字段默认 user(宽松不阻断)，但标 known:false
 */
import { describe, it, expect } from 'vitest';
import {
  classifyComposeField,
  validateComposePatch,
  annotateComposeAuthority,
} from '../../src/services/config-authority.js';

describe('classifyComposeField', () => {
  it('workDir / command / image → repo 权威', () => {
    expect(classifyComposeField('services.imp-api.build.workDir').authority).toBe('repo');
    expect(classifyComposeField('services.imp-api.build.command').authority).toBe('repo');
    expect(classifyComposeField('services.imp-api.image').authority).toBe('repo');
  });

  it('ports / networks / container_name → platform 权威', () => {
    expect(classifyComposeField('services.imp-api.ports').authority).toBe('platform');
    expect(classifyComposeField('services.imp-api.networks').authority).toBe('platform');
    expect(classifyComposeField('services.imp-api.container_name').authority).toBe('platform');
  });

  it('environment → user 权威', () => {
    expect(classifyComposeField('services.imp-api.environment').authority).toBe('user');
  });

  it('service 名归一: 不同 service 名同字段命中同一权威', () => {
    const a = classifyComposeField('services.foo.ports');
    const b = classifyComposeField('services.bar.ports');
    expect(a.authority).toBe('platform');
    expect(b.authority).toBe('platform');
  });

  it('未登记字段 → 默认 user + known:false', () => {
    const c = classifyComposeField('services.foo.someUnknownField');
    expect(c.authority).toBe('user');
    expect(c.known).toBe(false);
  });

  // 2026-05-29 Codex review(PR #684, P2×2):祖先前缀匹配 —— diff 递归到叶子后,
  // platform 子树下的任何改动都必须仍判 platform,否则改 networks 子键 / deploy.replicas
  // 会被当未登记 user 字段放行,绕过权威校验。
  it('顶层 platform 整键的子叶子继承 platform(networks.cds-net.driver)', () => {
    expect(classifyComposeField('networks').authority).toBe('platform');
    expect(classifyComposeField('networks.cds-net.driver').authority).toBe('platform');
    expect(classifyComposeField('networks.cds-net.driver').known).toBe(true);
  });

  it('x-cds-domain(顶层 platform)被识别', () => {
    expect(classifyComposeField('x-cds-domain').authority).toBe('platform');
  });

  it('嵌套 platform 叶子 services.*.deploy.replicas → platform', () => {
    expect(classifyComposeField('services.api.deploy.replicas').authority).toBe('platform');
    expect(classifyComposeField('services.api.deploy.replicas').known).toBe(true);
  });

  it('services.*.ports 的子项(若递归到数组以下)仍继承 platform', () => {
    // ports 通常是数组叶子,但即便结构变化递归更深,也必须继承 platform
    expect(classifyComposeField('services.api.ports.0').authority).toBe('platform');
  });

  it('deploy 下非 replicas 的未登记子键 → 仍是 user(不过度上锁)', () => {
    // services.*.deploy 本身未登记,只有 .replicas 是 platform;deploy.resources
    // 这类不应被误判 platform
    expect(classifyComposeField('services.api.deploy.resources').authority).toBe('user');
  });
});

describe('validateComposePatch', () => {
  it('agent 改 repo 字段(workDir) → 通过', () => {
    const r = validateComposePatch(['services.imp-api.build.workDir'], 'agent');
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('agent 改 platform 字段(ports) → reject 并回报违规', () => {
    const r = validateComposePatch(['services.imp-api.ports'], 'agent');
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].path).toBe('services.imp-api.ports');
    expect(r.violations[0].authority).toBe('platform');
  });

  it('user 改 platform 字段(networks) → 同样 reject', () => {
    const r = validateComposePatch(['services.imp-api.networks'], 'user');
    expect(r.ok).toBe(false);
  });

  it('platform actor(CDS 内部) → 任何字段都放行', () => {
    const r = validateComposePatch(
      ['services.imp-api.ports', 'services.imp-api.networks'],
      'platform',
    );
    expect(r.ok).toBe(true);
  });

  it('混合 patch: repo + platform 同改 → 只报 platform 违规', () => {
    const r = validateComposePatch(
      ['services.imp-api.build.workDir', 'services.imp-api.ports', 'services.imp-api.environment'],
      'agent',
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.path)).toEqual(['services.imp-api.ports']);
  });
});

describe('annotateComposeAuthority', () => {
  it('遍历 services 字段产出权威标注', () => {
    const parsed = {
      services: {
        'imp-api': { image: 'maven:3.9', ports: ['8080'], environment: { FOO: 'bar' } },
      },
    };
    const ann = annotateComposeAuthority(parsed);
    const byPath = Object.fromEntries(ann.map((a) => [a.path, a.authority]));
    expect(byPath['services.imp-api.image']).toBe('repo');
    expect(byPath['services.imp-api.ports']).toBe('platform');
    expect(byPath['services.imp-api.environment']).toBe('user');
  });

  it('空/无 services → 空数组', () => {
    expect(annotateComposeAuthority(null)).toEqual([]);
    expect(annotateComposeAuthority({})).toEqual([]);
  });
});
