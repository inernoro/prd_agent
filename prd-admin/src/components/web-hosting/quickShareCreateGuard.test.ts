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

  it('查不通时必须停手，不许 fall through 去建', () => {
    // 这次点击的前提是「这个站点还没有链接」。前提没能确认就照建，等于这道前置检查
    // 在最需要它的时候（网络抖动）恰好不生效——而那正是它要防的重复链接。
    const lookupAt = src.indexOf('listSiteShares(false, site.id)');
    const createAt = src.indexOf('createSiteShareLink({');
    const between = src.slice(lookupAt, createAt);
    expect(between).toContain('!scoped.success');
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

describe('每日验收脚本也要在查不通时停手', () => {
  // 与一步分享面板同一处置。上一轮我只修了面板那一处，脚本这边是同样的形状——
  // 「没查到」和「没查成」混成一件事，后者往下走 forceNew 会每天多建一条公开链接。
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'smoke', 'daily-acceptance.mjs'),
    'utf8',
  );

  it('ensureShare 查不通就抛，不许 fall through 去建', () => {
    const fnAt = script.indexOf('async function ensureShare(');
    const createAt = script.indexOf("api('/api/web-pages/share'", fnAt);
    expect(fnAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(fnAt);
    expect(script.slice(fnAt, createAt)).toContain('!mine.json?.success');
  });
});

describe('分享页取证必须在关页之前收齐', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'scripts', 'smoke', 'daily-acceptance.mjs'),
    'utf8',
  );

  it('checkShareArtifact 里 page.close() 排在所有取证之后', () => {
    // 页一关，帧就没了：之后任何 frame.evaluate 只会抛
    // 「Target page, context or browser has been closed」——实测过。
    // 而那种异常长得跟「页面真的没渲染」一模一样，于是判据会**永远红**：
    // 上一版把标记探测排在了 page.close() 之后，markerHit 恒为 false；
    // 文本形态字数达标又不会去取像素证据，两条路一起断，每条 HTML / Markdown
    // 验收永久假红。假红比漏判更糟——几次之后没人再看这份报告，回归信号就没了。
    //
    // 判据钉的是**顺序**，不是某一处写法：取证语句将来还会增加，扫的是整段函数体。
    const fnAt = script.indexOf('async function checkShareArtifact(');
    const fnEnd = script.indexOf('\nasync function ', fnAt + 10);
    expect(fnAt).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnAt);
    const body = script.slice(fnAt, fnEnd);

    const closeAt = body.indexOf('await page.close()');
    expect(closeAt).toBeGreaterThan(-1);

    // 每一处取证都必须排在关页之前
    for (const probe of ['inner.evaluate(', 'distinctColorCount(', 'page.$(\'iframe\')']) {
      const at = body.indexOf(probe);
      expect(at, `取证语句 ${probe} 没找到，测试该跟着改`).toBeGreaterThan(-1);
      expect(at, `${probe} 排到了 page.close() 之后，它只会抛异常`).toBeLessThan(closeAt);
    }
    // 关页之后不许再出现任何一次帧读取
    expect(body.slice(closeAt)).not.toContain('inner.evaluate(');
  });
});
