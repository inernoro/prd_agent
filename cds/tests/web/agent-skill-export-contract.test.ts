import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/src/routes/branches.ts'),
  'utf8',
);

describe('CDS 技能导出包契约', () => {
  it('导出通用 skills 结构并包含 manifest', () => {
    expect(source).toContain("path.join(packDir, 'skills', skillName)");
    expect(source).toContain("path.join(packDir, 'manifest.json')");
    expect(source).toContain("format: 'agent-skills'");
  });

  it('安装说明不再追加 shell alias 或要求 source', () => {
    expect(source).not.toContain("echo 'alias cdscli=");
    expect(source).not.toContain('source ~/.bashrc');
    expect(source).toContain('不要修改 PATH');
    expect(source).toContain('connect --host');
  });
});
