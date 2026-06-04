import { describe, it, expect } from 'vitest';
import { routeMatchesActionUrl, actionUrlPath, isEditorPageGuide, tipNavTarget } from '../pageGuideMatch';

const loc = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

// 锁定「pathname vs actionUrl」唯一比对口径(Bugbot 连环报 query-strip 漂移后固化)。
// 所有调用方(matchPageGuide / tips 过滤 / pageMatchedIndex / handleOpenTip)都走 routeMatchesActionUrl,
// 任一处再退回全串比对都会让下面的用例变红。
describe('actionUrlPath', () => {
  it('strips query and hash', () => {
    expect(actionUrlPath('/marketplace?type=skill')).toBe('/marketplace');
    expect(actionUrlPath('/visual-agent#x')).toBe('/visual-agent');
    expect(actionUrlPath('/a?b=1#c')).toBe('/a');
    expect(actionUrlPath('/clean')).toBe('/clean');
    expect(actionUrlPath('')).toBe('');
    expect(actionUrlPath(null)).toBe('');
  });
});

describe('routeMatchesActionUrl — 普通页面(非编辑器)', () => {
  it('精确匹配 pathname,忽略 actionUrl 的 query/hash', () => {
    expect(routeMatchesActionUrl('/marketplace', '/marketplace?type=skill', false)).toBe(true);
    expect(routeMatchesActionUrl('/marketplace', '/marketplace', false)).toBe(true);
  });
  it('默认不做前缀匹配', () => {
    expect(routeMatchesActionUrl('/marketplace/123', '/marketplace', false)).toBe(false);
  });
  it('allowListPrefix 时允许列表路由前缀', () => {
    expect(routeMatchesActionUrl('/defect-agent/123', '/defect-agent', false, { allowListPrefix: true })).toBe(true);
    expect(routeMatchesActionUrl('/defect-agent', '/defect-agent', false, { allowListPrefix: true })).toBe(true);
    expect(routeMatchesActionUrl('/other', '/defect-agent', false, { allowListPrefix: true })).toBe(false);
  });
});

describe('routeMatchesActionUrl — 编辑器教程', () => {
  it('深层前缀匹配(含旧版 -fullscreen/),且忽略 query', () => {
    expect(routeMatchesActionUrl('/visual-agent/abc', '/visual-agent?x=1', true)).toBe(true);
    expect(routeMatchesActionUrl('/visual-agent-fullscreen/abc', '/visual-agent', true)).toBe(true);
  });
  it('停在列表页(精确等于)不算「已在编辑器」', () => {
    expect(routeMatchesActionUrl('/visual-agent', '/visual-agent', true)).toBe(false);
  });
  it('空 actionUrl 不匹配', () => {
    expect(routeMatchesActionUrl('/x', '', false)).toBe(false);
    expect(routeMatchesActionUrl('/x', null, true)).toBe(false);
  });
});

describe('tipNavTarget — 导航保留 query 作为目标状态(与页面匹配相反)', () => {
  it('普通页 + actionUrl 含 query:不同 tab 时返回完整 url(需切 tab)', () => {
    const tip = { actionUrl: '/settings?tab=nav-order', sourceId: 'nav-order-page-guide' };
    expect(tipNavTarget(tip, loc('/settings', '?tab=user-space'))).toBe('/settings?tab=nav-order');
  });
  it('普通页 + actionUrl 含 query:已在目标 tab 时返回 null(不重复导航)', () => {
    const tip = { actionUrl: '/settings?tab=nav-order', sourceId: 'nav-order-page-guide' };
    expect(tipNavTarget(tip, loc('/settings', '?tab=nav-order'))).toBeNull();
  });
  it('普通页 + actionUrl 无 query:pathname 命中即 null,不抹掉用户当前 query', () => {
    const tip = { actionUrl: '/marketplace', sourceId: 'marketplace-page-guide' };
    expect(tipNavTarget(tip, loc('/marketplace', '?type=skill'))).toBeNull();
    expect(tipNavTarget(tip, loc('/marketplace'))).toBeNull();
    expect(tipNavTarget(tip, loc('/other'))).toBe('/marketplace');
  });
  it('编辑器教程:在深层路由即 null,query 无关;否则返回完整 url', () => {
    const tip = { actionUrl: '/visual-agent', sourceId: 'visual-editor-page-guide' };
    expect(tipNavTarget(tip, loc('/visual-agent/abc'))).toBeNull();
    expect(tipNavTarget(tip, loc('/visual-agent'))).toBe('/visual-agent'); // 停列表页 → 要进编辑器
  });
});

describe('isEditorPageGuide', () => {
  it('仅 *-editor-page-guide 命中', () => {
    expect(isEditorPageGuide('visual-editor-page-guide')).toBe(true);
    expect(isEditorPageGuide('visual-page-guide')).toBe(false);
    expect(isEditorPageGuide('editor-something')).toBe(false); // 非 -page-guide 结尾
    expect(isEditorPageGuide(null)).toBe(false);
  });
});
