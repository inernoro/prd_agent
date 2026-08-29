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
