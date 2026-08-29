import { useEffect, useState } from 'react';
import {
  DEFAULT_AGENT_ROLE_SELECTION,
  readAgentRoleSelection,
  subscribeAgentRoleSelection,
  writeAgentRoleSelection,
  type AgentRoleSelection,
} from '../lib/agent-role-store';

/**
 * 组件侧读取当前角色。首帧用默认值，挂载后再读 localStorage，
 * 避免服务端渲染或存储不可用时抛错。
 */
export function useAgentRoleSelection(): [
  AgentRoleSelection,
  (next: AgentRoleSelection) => void,
] {
  const [selection, setSelection] = useState<AgentRoleSelection>(DEFAULT_AGENT_ROLE_SELECTION);

  useEffect(() => {
    setSelection(readAgentRoleSelection());
    return subscribeAgentRoleSelection(setSelection);
  }, []);

  const update = (next: AgentRoleSelection): void => {
    setSelection(next);
    writeAgentRoleSelection(next);
  };

  return [selection, update];
}
