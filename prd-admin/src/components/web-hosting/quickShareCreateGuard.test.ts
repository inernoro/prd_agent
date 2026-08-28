import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「一步分享」在建链接之前必须按站点再问一次服务端。
 *
 * 外层传进来的 links 是全局最近 100 条（服务端 ListSharesAsync 硬性 Limit(100)）。
 * 某个站点的链接落在这个窗口外时它就是空的，直接 forceNew 会给一个其实已经分享过的
 * 站点再建一条重复链接，而卡片上还一直显示未分享——账号越用越脏，用户还看不出原因。
 *
 * 这条接线删掉之后没有任何用例会红（少一次网络请求，UI 照常渲染），所以用源码守卫钉住。
 */
describe('一步分享的建链接前置检查', () => {
  const src = fs.readFileSync(
    path.join(__dirname, 'QuickSharePopover.tsx'),
    'utf8',
  );

  it('建之前必须带 siteId 问一次服务端', () => {
    expect(src).toContain('listSiteShares(false, site.id)');
  });

  it('查到已有链接就不许再 forceNew', () => {
    // 顺序必须是「先查、命中就 return」再走 createSiteShareLink
    const lookupAt = src.indexOf('listSiteShares(false, site.id)');
    const createAt = src.indexOf('createSiteShareLink({');
    expect(lookupAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(lookupAt);
    const between = src.slice(lookupAt, createAt);
    expect(between).toContain('return;');
  });
});

describe('额度窗口过期后要能再问', () => {
  const dock = fs.readFileSync(
    path.join(__dirname, 'ask', 'AskDock.tsx'),
    'utf8',
  );

  it('拿服务端额度读数解除过期的那道门', () => {
    // 每小时/每天两档拒绝是有有效期的，卡片上也写着「过一会儿再来」。
    // 不解除的话门一落下只能刷新页面才起得来，与那句话直接矛盾。
    expect(dock).toContain('clearGateError');
    expect(dock).toMatch(/visitorRemaining\s*>\s*0/);
    expect(dock).toMatch(/siteRemaining\s*>\s*0/);
  });
});
