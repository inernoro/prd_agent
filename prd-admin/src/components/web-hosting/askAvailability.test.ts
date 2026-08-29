import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASK_UNSUPPORTED_ASSET_TYPES, isAskSupported } from './askAvailability';

describe('提问支持形态', () => {
  it('视频站不支持提问，其余支持', () => {
    expect(isAskSupported({ wrappedAssetType: 'video' })).toBe(false);
    expect(isAskSupported({ wrappedAssetType: 'VIDEO' })).toBe(false);
    expect(isAskSupported({ wrappedAssetType: 'pdf' })).toBe(true);
    expect(isAskSupported({ wrappedAssetType: 'markdown' })).toBe(true);
    expect(isAskSupported({ wrappedAssetType: null })).toBe(true);
    expect(isAskSupported({})).toBe(true);
  });

  it('前端不许用 === true 判提问开关（三态会把「没表过态」误判成关）', () => {
    // askEnabled 是三态：null / 缺字段 = 没表过态 = 开。写 `askEnabled === true`
    // 会把全部存量站点和新上传判成「关」，默认全开当场失效——而这正是这个字段
    // 从 bool 改成 bool? 之前的老写法，最容易被顺手写回去。
    const files = ['SitePreviewModal.tsx', 'ask/AskConfigDrawer.tsx'];
    for (const f of files) {
      const src = readFileSync(resolve(__dirname, f), 'utf-8');
      expect(src, `${f} 里出现了 askEnabled === true`).not.toMatch(/askEnabled\s*===\s*true/);
    }
  });

  it('上传完成提示不许再说提问默认关闭', () => {
    // 默认全开之后这句话是假的，而且关乎花钱：在意模型消耗的人读到「默认关着」
    // 就不会去关，实际上访客一进来就能问。判据只认「默认」与「关」同时出现在
    // 描述提问的那句话里。
    const page = readFileSync(resolve(__dirname, '../../pages/WebPagesPage.tsx'), 'utf-8');
    expect(page).not.toMatch(/「向我提问」[^<]*默认[^<]*关/);
    const drawer = readFileSync(resolve(__dirname, 'ask/AskConfigDrawer.tsx'), 'utf-8');
    expect(drawer).not.toMatch(/hint="[^"]*默认关闭/);
  });

  it('前端这份清单必须与后端 UnsupportedReason 一字不差', () => {
    // 前端本地判一次是为了上传完成那段提示不必等后端往返；代价就是这条守卫。
    // 后端哪天多加一种不支持形态（纯音频之类），这里不跟着改就红——
    // 否则又会变成「后端改了口径、前端文案还照旧承诺访客能问」。
    const cs = readFileSync(
      resolve(__dirname, '../../../../prd-api/src/PrdAgent.Core/Models/AskAccessPolicy.cs'),
      'utf-8',
    );
    const body = cs.slice(cs.indexOf('UnsupportedReason(string? wrappedAssetType)'));
    const head = body.slice(0, body.indexOf('=> UnsupportedReason') > 0 ? body.indexOf('=> UnsupportedReason') : 600);
    const backendTypes = [...head.matchAll(/Equals\(wrappedAssetType,\s*"([^"]+)"/g)].map((m) => m[1].toLowerCase());

    expect(backendTypes.length).toBeGreaterThan(0);
    expect([...backendTypes].sort()).toEqual([...ASK_UNSUPPORTED_ASSET_TYPES].sort());
  });
});
