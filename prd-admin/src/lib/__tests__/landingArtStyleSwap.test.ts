import { describe, expect, it } from 'vitest';
import {
  LANDING_PREVIEW_SLOTS,
  applyArtStyleToPrompt,
  buildLandingPreviewPrompt,
  landingArtStyle,
} from '../landingPreviewSlots';

/**
 * 守卫：**换了拍法再点「全部重新生成」，出来的必须真是新拍法。**
 *
 * 槽位一旦生成过，库里存的是「上一次那个拍法的前缀 + 画面描述」。重新生成时如果
 * 直接把它拿去跑，换拍法这件事根本不会发生——用户切了拍法、七次生图的钱花掉了、
 * 出来还是老样子，而按钮旁边写着「整套换一遍」。
 *
 * 另一头也得守住：画面描述可能被人手工调过（「这次别要雾」），一律重建会把他的
 * 修改冲掉。所以判据是两条一起：**前缀跟着当前拍法走，描述原样留着。**
 */

const slot = LANDING_PREVIEW_SLOTS[0];
const styles = ['muted', 'mono'] as const;

describe('重新生成时的拍法切换', () => {
  it('存过的提示词换拍法：前缀换新的，画面描述留着', () => {
    const stored = buildLandingPreviewPrompt(slot, styles[0]);
    const swapped = applyArtStyleToPrompt(stored, slot, styles[1]);
    expect(swapped.startsWith(landingArtStyle(styles[1]).prefix)).toBe(true);
    expect(swapped).not.toBe(stored);
    expect(swapped.endsWith(slot.subject)).toBe(true);
  });

  it('画面描述被手工改过时不许冲掉', () => {
    const edited = `${landingArtStyle(styles[0]).prefix}\n\n山谷，这次别要雾`;
    const swapped = applyArtStyleToPrompt(edited, slot, styles[1]);
    expect(swapped).toContain('这次别要雾');
    expect(swapped.startsWith(landingArtStyle(styles[1]).prefix)).toBe(true);
  });

  it('没存过就按当前拍法重建', () => {
    expect(applyArtStyleToPrompt(null, slot, styles[1])).toBe(buildLandingPreviewPrompt(slot, styles[1]));
    expect(applyArtStyleToPrompt('   ', slot, styles[1])).toBe(buildLandingPreviewPrompt(slot, styles[1]));
  });

  it('认不出结构（没有空行分隔）就重建，不猜哪段是前缀', () => {
    expect(applyArtStyleToPrompt('一整段没有空行的东西', slot, styles[1]))
      .toBe(buildLandingPreviewPrompt(slot, styles[1]));
  });

  it('两个拍法的前缀确实不同（否则上面几条是恒真的）', () => {
    expect(landingArtStyle(styles[0]).prefix).not.toBe(landingArtStyle(styles[1]).prefix);
  });
});
