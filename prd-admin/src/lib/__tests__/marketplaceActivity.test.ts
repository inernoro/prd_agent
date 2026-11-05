import { describe, expect, it } from 'vitest';
import { isNewMarketplaceUpload, marketplaceReleaseTime } from '../marketplaceActivity';

const now = Date.parse('2026-11-06T12:00:00Z');
const day = 86_400_000;
const before = (days: number) => new Date(now - days * day).toISOString();

describe('市场卡片活动时间', () => {
  it('新上传严格限定在过去七天，未来和无效日期不参与', () => {
    expect(isNewMarketplaceUpload(before(0), now)).toBe(true);
    expect(isNewMarketplaceUpload(before(7 - 1 / day), now)).toBe(true);
    expect(isNewMarketplaceUpload(before(7), now)).toBe(false);
    expect(isNewMarketplaceUpload(before(-1), now)).toBe(false);
    expect(isNewMarketplaceUpload('', now)).toBe(false);
    expect(isNewMarketplaceUpload('invalid', now)).toBe(false);
  });

  it.each([[0, '刚刚更新'], [1 / 24, '1 小时前更新'], [1 / 1440, '1 分钟前更新'], [3, '3 天前更新'], [7, '1 周前更新'], [29, '4 周前更新']])(
    '近期更新 %s 天使用可读的相对时间', (days, expected) => {
      expect(marketplaceReleaseTime(before(60), before(Number(days)), now)?.text).toBe(expected);
    },
  );

  it('三十天起使用日期，完整上传和更新时间仍在提示里', () => {
    const release = marketplaceReleaseTime(before(60), before(30), now)!;
    expect(release.text).toBe('2026-10-07');
    expect(release.dateTime).toBe(before(30));
    expect(release.title).toContain('上传时间：');
    expect(release.title).toContain('更新时间：');
  });

  it('缺失、无效或不晚于上传的更新时间不伪装成更新', () => {
    for (const updated of [undefined, '', 'invalid', before(3), before(4)]) {
      const release = marketplaceReleaseTime(before(3), updated, now)!;
      expect(release.text).toBe('3 天前上传');
      expect(release.title).not.toContain('更新时间');
    }
    expect(marketplaceReleaseTime('invalid', 'invalid', now)).toBeNull();
    expect(marketplaceReleaseTime('invalid', before(3), now)?.text).toBe('3 天前更新');
  });

  it('未来时间显示确切日期，不出现负数天或刚刚更新', () => {
    expect(marketplaceReleaseTime(before(-1), undefined, now)?.text).toBe('2026-11-07');
  });
});
