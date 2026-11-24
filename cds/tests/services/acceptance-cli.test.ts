import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

it('验收 CLI 票据、默认环境与归档契约的 Python 回归必须执行', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const output = execFileSync('python3', ['scripts/tests/test_cdscli_acceptance.py'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  expect(output).not.toContain('private-test-token');
});
