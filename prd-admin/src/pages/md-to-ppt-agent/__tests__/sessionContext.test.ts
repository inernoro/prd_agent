import { describe, expect, it } from 'vitest';
import { buildDesignArtifactLaunchPath } from '@/lib/designArtifactLaunch';
import { activatePptSessionContext, resolvePptSessionContext } from '../sessionContext';

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

  it('不可用的恢复指针不阻塞菜单启动，显式知识启动不依赖存储可用性', () => {
    const saved = { getItem: () => { throw new Error('disabled'); } };
    expect(resolvePptSessionContext({ key: 'menu', search: '' }, saved).id).toBe('legacy');
    expect(resolvePptSessionContext(launch(), saved).launch?.sourceEntryId).toBe('entry-a');
  });
});
