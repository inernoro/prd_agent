import { describe, expect, it } from 'vitest';
import { buildDesignArtifactLaunchPath } from '@/lib/designArtifactLaunch';
import { activatePptSessionContext, FRESH_PPT_SESSION_PATH, freshPptSessionPath, resolvePptSessionContext } from '../sessionContext';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

function launch(key = 'navigation-a', entry = 'entry-a') {
  const path = buildDesignArtifactLaunchPath({ target: 'html-ppt', sourceStoreId: 'store-a', sourceEntryId: entry, sourceTitle: '合成资料' });
  return { key, search: path.slice(path.indexOf('?')) };
}

describe('HTML PPT 知识启动上下文', () => {
  it('普通入口兼容旧会话与旧大纲键', () => {
    const saved = storage();
    saved.setItem('md-to-ppt-chat-v1', '原会话');
    saved.setItem('md-to-ppt-outline-run-v1', '原大纲');
    const context = resolvePptSessionContext({ key: 'menu', search: '' }, saved);
    expect(context.sessionKey).toBe('md-to-ppt-chat-v1');
    expect(context.outlineRunKey).toBe('md-to-ppt-outline-run-v1');
    expect(saved.getItem(context.sessionKey)).toBe('原会话');
    expect(saved.getItem(context.outlineRunKey)).toBe('原大纲');
  });

  it('新知识启动独立于旧稿，保留旧本地数据；同一页面刷新复用当前恢复键', () => {
    const saved = storage();
    saved.setItem('md-to-ppt-chat-v1', '原会话');
    saved.setItem('md-to-ppt-outline-run-v1', '原大纲');
    const context = resolvePptSessionContext(launch(), saved);
    expect(saved.getItem(context.sessionKey)).toBeNull();
    expect(saved.getItem(context.outlineRunKey)).toBeNull();
    activatePptSessionContext(context, saved);
    saved.setItem(context.sessionKey, '新稿');
    saved.setItem(context.outlineRunKey, '新大纲');
    expect(resolvePptSessionContext(launch(), saved)).toEqual(context);
    expect(saved.getItem('md-to-ppt-chat-v1')).toBe('原会话');
    expect(saved.getItem('md-to-ppt-outline-run-v1')).toBe('原大纲');
  });

  it('路由同组件切换另一知识或再次显式启动同一知识均是独立上下文', () => {
    const saved = storage();
    const initial = resolvePptSessionContext(launch(), saved);
    expect(resolvePptSessionContext(launch('navigation-b'), saved).id).not.toBe(initial.id);
    expect(resolvePptSessionContext(launch('navigation-a', 'entry-b'), saved).id).not.toBe(initial.id);
  });

  it('从普通菜单回到最近活动上下文；浏览器返回旧知识入口仍恢复对应旧稿', () => {
    const saved = storage();
    const first = resolvePptSessionContext(launch(), saved);
    const next = resolvePptSessionContext(launch('navigation-b', 'entry-b'), saved);
    activatePptSessionContext(first, saved);
    activatePptSessionContext(next, saved);
    expect(resolvePptSessionContext({ key: 'menu', search: '' }, saved)).toEqual(next);
    expect(resolvePptSessionContext(launch(), saved)).toEqual(first);
  });

  it('刷新后取到同一个 history key 就落回同一命名空间（含直达打开的 default）', () => {
    // react-router v7 的 BrowserRouter 把 key 写进 window.history.state（getHistoryState），
    // 读取时 `globalHistory.state?.key || 'default'`；history.state 随会话历史条目一起
    // 跨刷新存活，所以刷新同一条目拿到的是同一个 key。站内跳转来的条目是 push 时写下的
    // 随机 key，地址栏直达/新标签打开的条目从头到尾都是 'default' —— 两种都不会在刷新
    // 时改变，恢复游标因此找得回来（复审 P2 称刷新后一律变成 'default'，与此不符）。
    const saved = storage();
    const direct = resolvePptSessionContext(launch('default'), saved);
    activatePptSessionContext(direct, saved);
    saved.setItem(direct.sessionKey, '直达打开的稿子');

    expect(resolvePptSessionContext(launch('default'), saved)).toEqual(direct);
    expect(saved.getItem(direct.sessionKey)).toBe('直达打开的稿子');
    // 站内跳转来的条目同理，而且与直达那条互不串味。
    const pushed = resolvePptSessionContext(launch('navigation-a'), saved);
    expect(pushed.id).not.toBe(direct.id);
    expect(resolvePptSessionContext(launch('navigation-a'), saved)).toEqual(pushed);
  });

  it('不可用的恢复指针不阻塞菜单启动，显式知识启动不依赖存储可用性', () => {
    const saved = { getItem: () => { throw new Error('disabled'); } };
    expect(resolvePptSessionContext({ key: 'menu', search: '' }, saved).id).toBe('legacy');
    expect(resolvePptSessionContext(launch(), saved).launch?.sourceEntryId).toBe('entry-a');
  });

  it('「不带资料，直接打开」开一个空白会话，不恢复上一次；同一页面刷新仍是这个新会话', () => {
    const saved = storage();
    const previous = resolvePptSessionContext(launch(), saved);
    activatePptSessionContext(previous, saved);
    const search = FRESH_PPT_SESSION_PATH.slice(FRESH_PPT_SESSION_PATH.indexOf('?'));
    const fresh = resolvePptSessionContext({ key: 'blank-a', search }, saved);
    expect(fresh.id).not.toBe(previous.id);
    expect(fresh.launch).toBeNull();
    expect(saved.getItem(fresh.sessionKey)).toBeNull();
    expect(resolvePptSessionContext({ key: 'blank-a', search }, saved)).toEqual(fresh);
    expect(resolvePptSessionContext({ key: 'blank-b', search }, saved).id).not.toBe(fresh.id);
  });

  it('从团队空间点「不带资料」：空白会话仍带着团队，刷新与回到菜单入口都不丢', () => {
    const saved = storage();
    const target = freshPptSessionPath('team-7f3a');
    const search = target.slice(target.indexOf('?'));
    const fresh = resolvePptSessionContext({ key: 'blank-t', search }, saved);
    expect(fresh.launch).toBeNull();
    expect(fresh.destinationTeamId).toBe('team-7f3a');
    activatePptSessionContext(fresh, saved);
    expect(resolvePptSessionContext({ key: 'menu', search: '' }, saved).destinationTeamId).toBe('team-7f3a');
    // 个人空间与非法编号都不带团队
    expect(freshPptSessionPath(null)).toBe(FRESH_PPT_SESSION_PATH);
    expect(freshPptSessionPath('bad team!')).toBe(FRESH_PPT_SESSION_PATH);
  });

  it('知识交接的团队仍从 launch 取', () => {
    const path = buildDesignArtifactLaunchPath({ target: 'html-ppt', sourceStoreId: 's', sourceEntryId: 'e', sourceTitle: 't', destinationTeamId: 'team-9' });
    const context = resolvePptSessionContext({ key: 'k', search: path.slice(path.indexOf('?')) }, storage());
    expect(context.destinationTeamId).toBe('team-9');
  });
});
