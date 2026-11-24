import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redirectTarget } from '../../web/src/pages/LoginPage';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const loginPage = fs.readFileSync(path.join(repoRoot, 'cds/web/src/pages/LoginPage.tsx'), 'utf8');
const authFrame = fs.readFileSync(path.join(repoRoot, 'cds/web/src/components/skeletons/AuthPageSkeleton.tsx'), 'utf8');
const stylesheet = fs.readFileSync(path.join(repoRoot, 'cds/web/src/index.css'), 'utf8');

describe('CDS 登录页手机端主任务契约', () => {
  it('让登录卡在手机端先于品牌故事出现，并允许舞台内部滚动', () => {
    expect(loginPage).toContain('<AuthPageFrame>');
    expect(authFrame).toContain('className="cds-auth-copy"');
    expect(authFrame).toContain('className="cds-auth-card-wrap"');
    expect(authFrame.indexOf('className="cds-auth-copy"'))
      .toBeLessThan(authFrame.indexOf('className="cds-auth-card-wrap'));

    const mobileBlockStart = stylesheet.indexOf('@media (max-width: 640px) {', stylesheet.indexOf('.cds-auth-footer'));
    const mobileBlock = stylesheet.slice(mobileBlockStart, mobileBlockStart + 900);
    const mobilePage = mobileBlock.match(/\.cds-auth-page\s*\{([^}]*)\}/)?.[1];
    expect(mobilePage).toMatch(/(?:^|[;\n])\s*height:\s*100vh;/);
    expect(mobilePage).toMatch(/(?:^|[;\n])\s*height:\s*100dvh;/);
    const mobileStage = mobileBlock.match(/\.cds-auth-stage\s*\{([^}]*)\}/)?.[1];
    expect(mobileStage).toMatch(/(?:^|[;\n])\s*min-height:\s*0;/);
    expect(mobileBlock).toContain('.cds-auth-stage {');
    expect(mobileBlock).toContain('justify-content: flex-start;');
    expect(mobileBlock).toContain('overflow-y: auto;');
    expect(mobileBlock).toContain('.cds-auth-card-wrap {');
    expect(mobileBlock).toContain('order: -1;');
  });
});


describe('CDS 过期会话通知深链', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['?redirect=%2Fcds-settings', '#scheduler', '/cds-settings#scheduler'],
    ['?redirect=%2Fcds-settings%3Fproject%3Ddemo', '#scheduler', '/cds-settings?project=demo#scheduler'],
    ['?redirect=%2Fcds-settings%23alarms', '#scheduler', '/cds-settings#alarms'],
    ['?redirect=%2Fproject-list', '', '/project-list'],
    ['?redirect=%2F%2Fevil.invalid', '#scheduler', '/project-list'],
    ['?redirect=https%3A%2F%2Fevil.invalid', '#scheduler', '/project-list'],
    ['?redirect=%2Flogin', '#scheduler', '/project-list'],
  ])('登录目标 %s %s 保持内部路径和原目标锚点', (search, hash, expected) => {
    // Real server redirects cannot read the URL fragment; browsers inherit it on /login.
    vi.stubGlobal('window', { location: { search, hash } });
    expect(redirectTarget()).toBe(expected);
  });
});
