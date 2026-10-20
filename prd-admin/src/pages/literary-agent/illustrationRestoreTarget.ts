import type { LiteraryIllustrationHistory, LiteraryIllustrationHistoryItem } from '@/services/real/literaryAgentConfig';

export type RestorePositionOption = {
  index: number;
  /** 下拉里显示的文字：「配图 3 · 窗边的猫（原位置）」 */
  label: string;
  /** 这个位置现在的完整描述（悬停看全） */
  description: string;
};

export type RestorePlan = {
  /** 能不能放回：没在用、且当前方案里至少有一个位置 */
  restorable: boolean;
  /** 不选时放到哪：原位置还在就是原位置；当前只有一个位置就是那一个；否则要用户选 */
  defaultTarget?: number;
  /** 只有一个可选位置时不显示下拉（没得选就别假装能选） */
  showPicker: boolean;
  options: RestorePositionOption[];
};

const MAX_DESC = 16;

/**
 * 历史配图里一张图可以放回到哪里。
 *
 * 以前只认「它当初的位置」：改稿删掉或重排了标记后，原位置不在了的旧图、以及没记位置的早期图，
 * 在历史里看得到却放不回去。现在当前方案里的任意位置都能选，原位置还在时默认选它。
 */
export function planRestore(
  data: Pick<LiteraryIllustrationHistory, 'markerIndexes' | 'markers'> | null | undefined,
  item: Pick<LiteraryIllustrationHistoryItem, 'isCurrent' | 'markerIndex'>,
): RestorePlan {
  const positions = data?.markerIndexes ?? [];
  const descOf = (i: number) => data?.markers?.find((m) => m.index === i)?.description ?? '';
  const original = item.markerIndex != null && positions.includes(item.markerIndex) ? item.markerIndex : undefined;
  const options = positions.map((index) => {
    const description = descOf(index);
    const short = description.length > MAX_DESC ? `${description.slice(0, MAX_DESC)}…` : description;
    const label = `配图 ${index + 1}${short ? ` · ${short}` : ''}${index === original ? '（原位置）' : ''}`;
    return { index, label, description };
  });
  return {
    restorable: !item.isCurrent && positions.length > 0,
    defaultTarget: original ?? (positions.length === 1 ? positions[0] : undefined),
    showPicker: positions.length > 1,
    options,
  };
}
