import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('连续性能窗口证据', () => {
  it('在模块测试中执行 Python 判据及真实 HTTP 协议回归', () => {
    const result = spawnSync('python3', [
      fileURLToPath(new URL('../../scripts/test-control-plane-window.py', import.meta.url)), '-v',
    ], { encoding: 'utf8', timeout: 15_000 });
    const diagnostic = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('OK');
  }, 20_000);
});
