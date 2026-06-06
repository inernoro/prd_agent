import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// 文档阅读器的个人偏好。
// 划词评论的展示布局是「纯 UI 偏好 + 设备本地 + 发版后用旧值无害」——
// 按 no-localstorage.md 的例外清单（同视图模式/排序方式），允许走 localStorage，
// 这样「关浏览器再打开」也记得用户上次选的布局，不必每次重选。
export type InlineCommentLayout = 'margin' | 'inline';

interface DocReaderPrefsState {
  /** 划词评论布局：margin=右侧批注栏（飞书/Docs 式）；inline=正文内联气泡展开（GitHub 式） */
  inlineCommentLayout: InlineCommentLayout;
  setInlineCommentLayout: (layout: InlineCommentLayout) => void;
}

export const useDocReaderPrefs = create<DocReaderPrefsState>()(
  persist(
    (set) => ({
      inlineCommentLayout: 'margin',
      setInlineCommentLayout: (inlineCommentLayout) => set({ inlineCommentLayout }),
    }),
    {
      name: 'prd-admin-doc-reader',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
