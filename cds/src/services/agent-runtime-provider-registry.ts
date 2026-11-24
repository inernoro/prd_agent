export type AgentWorkloadKind = 'general' | 'repository-change' | 'design-artifact';
export type AgentIsolationMode = 'shared-runtime' | 'session-container';

// 会话级容器分配器的实现事实。路由还会检查运行时实例是否真实注入并探测 Docker，
// 所以该值为 true 不会让缺少容器底座的 CDS 节点误报 selectable。
export const AGENT_RESOURCE_POLICY_ENFORCED_PER_SESSION = true;

export interface AgentRuntimeProviderDefinition {
  id: string;
  label: string;
  adapterKind: 'internal-smoke' | 'agent-sdk' | 'cli-adapter' | 'design-daemon' | 'custom-adapter';
  executionOwner: 'cds-remote-agent';
  implementationStatus: 'available' | 'planned';
  productEligible: boolean;
  workloadKinds: AgentWorkloadKind[];
  supportedIsolationModes: AgentIsolationMode[];
  requiredIsolationMode: AgentIsolationMode;
  runtimeProtocol: string;
  reason?: string;
}

const DEFINITIONS: AgentRuntimeProviderDefinition[] = [
  {
    id: 'fake',
    label: 'CDS 测试运行时',
    adapterKind: 'internal-smoke',
    executionOwner: 'cds-remote-agent',
    implementationStatus: 'available',
    productEligible: false,
    workloadKinds: ['general'],
    supportedIsolationModes: ['shared-runtime'],
    requiredIsolationMode: 'shared-runtime',
    runtimeProtocol: 'cds-fake-events-v1',
    reason: '仅用于 CDS 自测，不能作为产品任务执行器',
  },
  {
    id: 'claude-sdk',
    label: 'Claude Agent SDK',
    adapterKind: 'agent-sdk',
    executionOwner: 'cds-remote-agent',
    implementationStatus: 'available',
    productEligible: true,
    workloadKinds: ['general', 'repository-change', 'design-artifact'],
    supportedIsolationModes: ['shared-runtime'],
    requiredIsolationMode: 'shared-runtime',
    runtimeProtocol: 'cds-agent-sse-v1',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    adapterKind: 'cli-adapter',
    executionOwner: 'cds-remote-agent',
    implementationStatus: 'planned',
    productEligible: true,
    workloadKinds: ['general', 'repository-change', 'design-artifact'],
    supportedIsolationModes: [],
    requiredIsolationMode: 'session-container',
    runtimeProtocol: 'cds-agent-sse-v1',
    reason: 'Codex 运行时传输与会话级容器分配器尚未接入',
  },
  {
    id: 'open-design',
    label: 'OpenDesign',
    adapterKind: 'design-daemon',
    executionOwner: 'cds-remote-agent',
    implementationStatus: 'available',
    productEligible: true,
    workloadKinds: ['design-artifact'],
    supportedIsolationModes: ['session-container'],
    requiredIsolationMode: 'session-container',
    runtimeProtocol: 'cds-design-artifact-events-v1',
  },
  {
    id: 'custom',
    label: '自定义 Agent 运行时',
    adapterKind: 'custom-adapter',
    executionOwner: 'cds-remote-agent',
    implementationStatus: 'planned',
    productEligible: true,
    workloadKinds: ['general', 'repository-change', 'design-artifact'],
    supportedIsolationModes: [],
    requiredIsolationMode: 'session-container',
    runtimeProtocol: 'cds-agent-sse-v1',
    reason: '自定义运行时必须先注册传输适配器与隔离策略',
  },
];

export function listAgentRuntimeProviderDefinitions(): AgentRuntimeProviderDefinition[] {
  return DEFINITIONS.map((item) => ({
    ...item,
    workloadKinds: [...item.workloadKinds],
    supportedIsolationModes: [...item.supportedIsolationModes],
  }));
}

export function findAgentRuntimeProviderDefinition(runtime: unknown): AgentRuntimeProviderDefinition | null {
  if (typeof runtime !== 'string') return null;
  return listAgentRuntimeProviderDefinitions().find((item) => item.id === runtime.trim().toLowerCase()) ?? null;
}

export function normalizeAgentWorkloadKind(value: unknown): AgentWorkloadKind {
  return value === 'repository-change' || value === 'design-artifact' || value === 'general'
    ? value
    : 'general';
}

export function normalizeAgentIsolationMode(
  value: unknown,
  provider: AgentRuntimeProviderDefinition,
): AgentIsolationMode {
  if (value === 'shared-runtime' || value === 'session-container') return value;
  return provider.requiredIsolationMode;
}

export function isAgentRuntimeProviderIsolationReady(
  provider: AgentRuntimeProviderDefinition,
  resourcePolicyEnforcedPerSession: boolean,
): boolean {
  if (!provider.supportedIsolationModes.includes(provider.requiredIsolationMode)) return false;
  return provider.requiredIsolationMode !== 'session-container' || resourcePolicyEnforcedPerSession;
}
