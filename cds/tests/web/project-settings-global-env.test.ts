import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/ProjectSettingsPage.tsx'),
  'utf8',
);

describe('project settings CDS global variable inheritance contract', () => {
  it('exposes the explicit project-scoped opt-in and persists it through the project API', () => {
    expect(source).toContain('继承 CDS 全局变量');
    expect(source).toContain('默认关闭，避免其他项目的凭据进入当前项目');
    expect(source).toContain('body: { inheritGlobalEnv: project.inheritGlobalEnv !== true }');
    expect(source).toContain("method: 'PUT'");
    expect(source).toContain('重新部署后生效');
  });
});
