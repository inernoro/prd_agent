import { describe, expect, it } from 'vitest';
import { fitLiteraryImageSize, imageRunFailure } from './literaryImageRunContract';

describe('文学配图模型切换契约', () => {
  const flash = { '1k': [{ size: '1264x848', aspectRatio: '3:2' }], '2k': [], '4k': [] };
  const seedream = { '1k': [], '2k': [{ size: '2048x2048', aspectRatio: '1:1' }, { size: '2400x1600', aspectRatio: '3:2' }], '4k': [] };
  it('Pro 的旧尺寸切 Flash 时重新落到 Flash 白名单', () => {
    expect(fitLiteraryImageSize('1248x832', flash)).toBe('1264x848');
  });
  it('切豆包时按原比例升级到模型声明的合法面积', () => {
    expect(fitLiteraryImageSize('1264x848', seedream)).toBe('2400x1600');
  });
  it('保留手动选择，空目录或不支持比例拒绝生成', () => {
    expect(fitLiteraryImageSize('2400x1600', seedream)).toBe('2400x1600');
    expect(fitLiteraryImageSize('1376x768', seedream)).toBeNull();
    expect(fitLiteraryImageSize('1024x1024', { '1k': [], '2k': [], '4k': [] })).toBeNull();
  });
  it('保留单图与整批失败，成功和心跳不会制造错误', () => {
    expect(imageRunFailure({ type: 'imageError', errorMessage: '额度不足，请更换模型' })).toBe('额度不足，请更换模型');
    expect(imageRunFailure({ type: 'error', errorMessage: '模型不再可用' })).toBe('模型不再可用');
    expect(imageRunFailure({ type: 'imageDone' })).toBeNull();
  });
});
