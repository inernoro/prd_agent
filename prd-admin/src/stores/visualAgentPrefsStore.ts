/**
 * 视觉创作偏好 store
 *
 * 前端轻量偏好：仅影响"发送前的预检"UX，不替代后端的模型调度决策。
 * - smartModelFallback: true（默认）= 发送前若检测到用户选的模型不可用，弹窗询问是否切换
 *                      false（严格模式）= 直接按用户选择发送，不弹窗，让后端去做调度/降级
 *
 * 持久化：sessionStorage（遵守项目 no-localstorage 规则）。
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface VisualAgentPrefsState {
  /** 智能切换（默认开启）。关闭后进入严格模式：不弹窗询问，直接按用户选择发送。 */
  smartModelFallback: boolean;
  setSmartModelFallback: (v: boolean) => void;
}

export const useVisualAgentPrefsStore = create<VisualAgentPrefsState>()(
  persist(
    (set) => ({
      smartModelFallback: true,
      setSmartModelFallback: (v: boolean) => set({ smartModelFallback: v }),
    }),
    {
      name: 'visual-agent-prefs',
      storage: createJSONStorage(() => sessionStorage),
    }
  )
);
