import { create } from 'zustand';

/** 技能分享弹窗的全局单例 store。卡片 / 详情弹窗等任意处调用 open() 即可拉起带「有效期」选择的分享弹窗。 */
export type SkillShareTarget = { id: string; title: string };

type SkillShareDialogState = {
  target: SkillShareTarget | null;
  open: (target: SkillShareTarget) => void;
  close: () => void;
};

export const useSkillShareDialogStore = create<SkillShareDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** 命令式入口：在事件回调里直接 `skillShareDialog.open({ id, title })`，无需在每个调用处接 hook。 */
export const skillShareDialog = {
  open: (target: SkillShareTarget) => useSkillShareDialogStore.getState().open(target),
};
