import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../WebPagesPage.tsx', import.meta.url), 'utf8');

/**
 * 上传与「引用知识生成」是两条创建路径，在团队空间里新建的站点都必须归属该团队，
 * 否则会落到个人空间、从当前列表里消失。
 *
 * 但两条路径的**归属该由谁做**并不相同（2026-09-15 第二轮修正）：
 *  - 上传是同步请求，响应回来时用户一定还在，归属留在前端是对的；
 *  - 生成是长任务，用户很可能在终态之前关掉页面或切走，归属若只活在完成回调里就会丢。
 *    所以生成的目标空间随创建请求冻结到服务端，由服务端建站时应用。
 *
 * 前端只保留「分组」这一层：它依赖当前视图，服务端不知道；而且丢了也只是没进文件夹，
 * 网页仍在团队空间里看得见。
 */
describe('团队空间里生成的网页要归属该团队', () => {
  it('上传路径的归属仍在前端，且只有一份实现', () => {
    // 定义处是 `= async (`，不含「名字(」，所以下面的正则只会匹配调用点。
    expect(page).toContain('const assignNewSiteToDialogSpace = async (');
    const calls = page.match(/assignNewSiteToDialogSpace\(/g) ?? [];
    expect(calls, '上传路径的归属只该有这一处调用').toHaveLength(1);
    expect(page).toContain("assignNewSiteToDialogSpace(saved.id, '上传')");
  });

  it('生成路径把目标空间交给服务端，回调只补分组', () => {
    const start = page.indexOf('<SiteGenerateDialog');
    expect(start).toBeGreaterThan(-1);
    const body = page.slice(start, start + 900);
    // companion：确实截到了这个弹窗的 props。
    expect(body).toContain('onCreated');
    expect(body, '没有把目标空间随请求送给服务端').toContain('destinationTeamId=');
    expect(body, '生成回调仍在自己归属团队：用户中途离开时这条回调根本不会执行')
      .not.toContain('assignNewSiteToDialogSpace');
    expect(body).toMatch(/onCreated=\{\(siteId\)/);
    expect(body).toContain('groupNewSiteInDialogSpace(siteId');
  });

  it('深链直接开生成弹窗时也快照了空间，不会用上一次的旧值', () => {
    const start = page.indexOf('setShowGenerateDialog(true);\n  }, [location.search');
    expect(start, '深链打开生成弹窗的那处不见了').toBeGreaterThan(-1);
    const before = page.slice(Math.max(0, start - 400), start);
    expect(before).toContain('uploadDialogSpaceRef.current = currentSpace;');
  });
});
