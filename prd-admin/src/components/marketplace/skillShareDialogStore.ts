import { create } from 'zustand';

/** 技能分享弹窗的全局单例 store。卡片 / 详情弹窗等任意处调用 open() 即可拉起带「有效期」选择的分享弹窗。 */
export type SkillShareTarget = { id: string; title: string };

type SkillShareDialogState = {
  target: SkillShareTarget | null;
  /** 正在生成链接中。生成期间忽略 open()，避免别处的分享按钮把 target 换掉、
   *  导致界面显示 A 技能但复制到的是 B 技能的链接（in-flight 请求仍用旧 id）。 */
  busy: boolean;
  open: (target: SkillShareTarget) => void;
  setBusy: (busy: boolean) => void;
  close: () => void;
};

export const useSkillShareDialogStore = create<SkillShareDialogState>((set, get) => ({
  target: null,
  busy: false,
  open: (target) => {
    if (get().busy) return;
    set({ target });
  },
  setBusy: (busy) => set({ busy }),
  close: () => set({ target: null }),
}));

/** 命令式入口：在事件回调里直接 `skillShareDialog.open({ id, title })`，无需在每个调用处接 hook。 */
export const skillShareDialog = {
  open: (target: SkillShareTarget) => useSkillShareDialogStore.getState().open(target),
};
