import { createContext, useContext, useEffect } from 'react';

export type ShareAssistantActionId = 'ask' | 'edit';
export interface ShareAssistantAction {
  activate: () => void;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  rounds: number;
}
export const ShareAssistantContext = createContext<{
  register: (id: ShareAssistantActionId, action: ShareAssistantAction) => () => void;
  activeId?: ShareAssistantActionId;
} | null>(null);

/** 注册入口，不接管面板生命周期，折叠后仍保留原会话和草稿。 */
export function useShareAssistantAction(id: ShareAssistantActionId, activate: () => void,
  { active, busy = false, disabled = false, rounds = 0 }: Partial<Omit<ShareAssistantAction, 'activate'>> & { active: boolean }) {
  const register = useContext(ShareAssistantContext)?.register;
  useEffect(() => register?.(id, { activate, active, busy, disabled, rounds }),
    [register, id, activate, active, busy, disabled, rounds]);
}
