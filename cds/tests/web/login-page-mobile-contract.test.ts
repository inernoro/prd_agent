import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const loginPage = fs.readFileSync(path.join(repoRoot, 'cds/web/src/pages/LoginPage.tsx'), 'utf8');
const stylesheet = fs.readFileSync(path.join(repoRoot, 'cds/web/src/index.css'), 'utf8');

describe('CDS 登录页手机端主任务契约', () => {
  it('让登录卡在手机端先于品牌故事出现，并允许舞台内部滚动', () => {
    expect(loginPage.indexOf('className="cds-auth-copy"'))
      .toBeLessThan(loginPage.indexOf('className="cds-auth-card-wrap'));

    const mobileBlockStart = stylesheet.indexOf('@media (max-width: 640px) {', stylesheet.indexOf('.cds-auth-footer'));
    const mobileBlock = stylesheet.slice(mobileBlockStart, mobileBlockStart + 900);
    expect(mobileBlock).toContain('.cds-auth-stage {');
    expect(mobileBlock).toContain('justify-content: flex-start;');
    expect(mobileBlock).toContain('overflow-y: auto;');
    expect(mobileBlock).toContain('.cds-auth-card-wrap {');
    expect(mobileBlock).toContain('order: -1;');
  });
});
