import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sharePage = readFileSync(new URL('../ShareViewPage.tsx', import.meta.url), 'utf8');
const webPages = readFileSync(new URL('../WebPagesPage.tsx', import.meta.url), 'utf8');
const dialog = readFileSync(
  new URL('../../components/web-hosting/SiteGenerateDialog.tsx', import.meta.url), 'utf8');

/**
 * 两件只有服务端知道的事，不再由浏览器拿代理量推（Codex P2 x2，2026-09-15）。
 *
 * 一、分享页的编辑坞：判据曾是「谁建了这条分享链接」，而后端明确允许团队编辑者建分享，
 *     两者一错位就同时出两种错——真正的站点主人进不去、只建过链接的人反而看得见。
 * 二、生成任务的目标空间：归属曾只活在浏览器的完成回调里，用户中途关掉页面就丢，
 *     服务端照样把站点生成完、留在个人空间。
 */
describe('只有服务端知道的结论由服务端给', () => {
  it('分享页的编辑坞走后端结论，不再拿 createdBy 推', () => {
    const dockAt = sharePage.indexOf('<ShareSiteEditDock');
    expect(dockAt, '编辑坞不见了').toBeGreaterThan(-1);
    const gate = sharePage.slice(Math.max(0, dockAt - 700), dockAt);

    expect(gate, '编辑坞的门没有走后端给的 viewerCanEdit').toContain('site.viewerCanEdit');
    expect(gate, '编辑坞又被 isOwner 把住了：那是「谁建了这条分享链接」')
      .not.toMatch(/\{isOwner &&/);
  });

  it('「存一份副本」那类提示仍然用 isOwner——两个判据服务的是两个问题', () => {
    // companion：这个判据本身还在（它在那里问的正是「这条链接是不是我建的」）。
    expect(sharePage).toContain("data.createdBy === currentUserId");
    expect(sharePage).toMatch(/\{!isOwner && \(/);
  });

  it('生成弹窗把目标空间随请求送出去，且在打开那一刻冻结', () => {
    expect(dialog).toContain('destinationTeamId: destinationTeamIdRef.current ?? null,');
    // 冻结点必须在「打开弹窗」的重置段里，不是跟着 prop 实时变。
    const openReset = dialog.indexOf("setInstruction('');");
    expect(openReset).toBeGreaterThan(-1);
    const freeze = dialog.indexOf('destinationTeamIdRef.current = destinationTeamId;');
    expect(freeze, '目标空间没有在打开那一刻冻结').toBeGreaterThan(-1);
    expect(Math.abs(freeze - openReset), '冻结点离打开重置段太远，多半又变成实时跟随了')
      .toBeLessThan(400);
  });

  it('生成完成回调不再自己归属团队（服务端已经归好），只补分组', () => {
    const createdAt = webPages.indexOf('<SiteGenerateDialog');
    expect(createdAt).toBeGreaterThan(-1);
    const usage = webPages.slice(createdAt, createdAt + 900);

    expect(usage, '没有把目标空间传给生成弹窗').toContain('destinationTeamId=');
    expect(usage, '完成回调仍在自己归属团队：用户中途离开时这条回调根本不会执行')
      .not.toContain('assignNewSiteToDialogSpace');
    expect(usage).toContain('groupNewSiteInDialogSpace');

    // 上传那条路径不同：请求是同步的，响应回来时用户一定还在，归属留在前端是对的。
    expect(webPages).toContain("assignNewSiteToDialogSpace(saved.id, '上传')");
  });
});
