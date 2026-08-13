import { create } from 'zustand';

/**
 * 移动端「沉浸阅读」顶栏接管（2026-08-10 用户确认的交互）：
 * 进入文档阅读态时，AppShell 移动顶栏由「汉堡 + 应用名 + 铃铛」切换为
 * 「返回箭头 + 文档标题」——内容页替代顶栏是移动端标准范式（微信文章/掘金同款），
 * 返回一步即恢复完整顶栏，通知红点不丢。
 *
 * 同时各调用方页面（知识库店头行 / 更新中心 TabBar 行 / 分享页头）订阅
 * `override != null` 在移动阅读态隐藏自己的头部行，把首屏让给正文。
 *
 * 纯内存态（不持久化）：由 DocBrowser 在移动阅读态 set / 离开时 clear。
 */
interface ReaderChromeOverride {
  /** 顶栏展示的文档标题 */
  title: string;
  /** 返回箭头动作：退出阅读态回列表 */
  onBack: () => void;
}

interface ReaderChromeState {
  override: ReaderChromeOverride | null;
  setOverride: (next: ReaderChromeOverride) => void;
  clearOverride: () => void;
}

export const useReaderChromeStore = create<ReaderChromeState>((set) => ({
  override: null,
  setOverride: (next) => set({ override: next }),
  clearOverride: () => set({ override: null }),
}));
