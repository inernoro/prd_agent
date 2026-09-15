import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../WebPagesPage.tsx', import.meta.url), 'utf8');

/**
 * 上传与「引用知识生成」是两条创建路径。在团队空间里新建的站点必须归属该团队，
 * 否则会落到个人空间、从当前列表里消失——上传那条早就做了（源码里还留着
 * 「串数据修复」的注释），生成那条却只 load() 不认 siteId（Codex P2，2026-09-15）。
 * 同一件事两处做、只做了一处，正是判据分裂（形状 3）。这里钉住它们共用同一套判据。
 */
describe('团队空间里生成的网页要归属该团队', () => {
  it('归属逻辑只有一份，且两条创建路径都调它', () => {
    // 定义处是 `= async (`，不含「名字(」，所以下面的正则只会匹配调用点。
    expect(page).toContain('const assignNewSiteToDialogSpace = async (');
    const calls = page.match(/assignNewSiteToDialogSpace\(/g) ?? [];
    expect(calls, '上传与生成两条创建路径都必须走同一套归属判据').toHaveLength(2);
  });

  it('生成完成回调拿到了 siteId 并走归属，而不是只刷新列表', () => {
    const start = page.indexOf('<SiteGenerateDialog');
    expect(start).toBeGreaterThan(-1);
    const body = page.slice(start, start + 700);
    // companion：确实截到了这个弹窗的 props。
    expect(body).toContain('onCreated');
    expect(body, '生成回调忽略了 siteId，团队空间里生成的网页会落到个人空间')
      .toMatch(/onCreated=\{\(siteId\)/);
    expect(body).toContain('assignNewSiteToDialogSpace(siteId');
  });

  it('深链直接开生成弹窗时也快照了空间，不会用上一次的旧值', () => {
    const start = page.indexOf('setShowGenerateDialog(true);\n  }, [location.search');
    expect(start, '深链打开生成弹窗的那处不见了').toBeGreaterThan(-1);
    const before = page.slice(Math.max(0, start - 400), start);
    expect(before).toContain('uploadDialogSpaceRef.current = currentSpace;');
  });
});
