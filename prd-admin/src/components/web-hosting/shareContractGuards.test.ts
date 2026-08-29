import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const askDock = read('./ask/AskDock.tsx');
const askPanel = read('./ask/AskPanel.tsx');
const popover = read('./QuickSharePopover.tsx');
const loginPage = read('../../pages/LoginPage.tsx');
const controller = read(
  '../../../../prd-api/src/PrdAgent.Api/Controllers/Api/WebPageAskController.cs');

/**
 * 三条都属于「两端各说各的」：一端写的名字/组件，另一端根本不认。
 * 编译过、测试绿、通读也看不出——只有真跑一遍才会发现东西没到。
 */
describe('登录回跳的参数名两端要对得上', () => {
  it('LoginPage 认的是 returnUrl', () => {
    expect(loginPage).toContain("searchParams.get('returnUrl')");
  });

  it('提问坞与提问面板都按这个名字传，传别的会静默回首页', () => {
    for (const src of [askDock, askPanel]) {
      expect(src).toContain('/login?returnUrl=');
      expect(src).not.toContain('/login?redirect=');
    }
  });
});

describe('重新生成的返回字段名', () => {
  it('冲突分支与正常分支用同一个字段名', () => {
    // 抽屉只读 suggestedQuestions；冲突分支写成别的名字，它会读到 undefined
    // 然后 `?? []` 把界面上的题清空，接着一次保存就覆盖掉别人刚写的整份
    const conflict = controller.slice(
      controller.indexOf('generated = false,'),
      controller.indexOf('generated = false,') + 900);
    expect(conflict).toContain('suggestedQuestions =');
    expect(conflict).not.toMatch(/^\s*questions =/m);
  });

  it('控制器里不存在裸的 questions = 返回字段', () => {
    expect(controller).not.toMatch(/\n\s{16}questions = current/);
  });
});

describe('加载态用统一组件', () => {
  it('一步分享面板不再自己拿图标转圈', () => {
    // frontend-architecture 强制规则：一律 MapSpinner
    expect(popover).not.toContain('Loader2');
    expect(popover).toContain("import { MapSpinner } from '@/components/ui/VideoLoader'");
  });

  it('三处加载态都换过来了', () => {
    const hits = popover.match(/<MapSpinner /g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});
