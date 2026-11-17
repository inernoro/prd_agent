/** CDS owns policy and admission. SeaTunnel owns database transport. */
export const DTS_PROTOCOL_VERSION = 1;
export const SEATUNNEL_VERSION = '3.0.0';
export const DTS_KINDS = ['mongo', 'redis', 'mysql', 'postgres', 'rabbitmq'] as const;
export type DtsKind = typeof DTS_KINDS[number];
export type DtsMode = 'append-only' | 'account-authority';
export type DtsFieldType = 'string' | 'boolean' | 'int' | 'bigint' | 'double' | 'timestamp';
export interface DtsContract {
  id: string;
  version: number;
  /** A target explicitly declares which source contracts it accepts. */
  accepts: number[];
  fields: Record<string, DtsFieldType>;
}
export interface DtsConnection {
  id: string; projectId: string; name: string; kind: DtsKind;
  /** Reference to an existing private project environment value, never a copied URI. */
  uriEnv: string; infraId?: string; database: string; collection: string; contract: DtsContract;
  /** Account mutations are restricted to this administrator-approved field set. */
  environmentRole: 'production' | 'standby' | 'acceptance' | 'other'; allowWrite: boolean;
  accountFields: string[]; createdAt: string;
}
export interface DtsManagedService {
  id: string; projectId: string; name: string; kind: DtsKind; database: string | null;
  uriEnv: string; status: string; ready: boolean;
}
export interface DtsEngineBinding {
  projectId: string; baseUrl: string; version: typeof SEATUNNEL_VERSION;
  usernameEnv: string; passwordEnv: string;
  adapters?: Record<string,string>;
}
export interface DtsActor {
  kind: 'static' | 'project-key' | 'user' | 'legacy-owner' | 'principal';
  id: string; fingerprint?: string;
}
export interface DtsRabbitObject { kind:'exchange'|'queue'|'binding'; id:string; value:Record<string,unknown> }
export interface DtsRedisEntry { key:string; type:string; expireAt:number; digest:string; bytes:number }
export interface DtsPlan {
  id: string; projectId: string; sourceId: string; targetId: string; mode: DtsMode;
  createdAt: string; expiresAt: string; profileOnly?: boolean;
  sourceFingerprint: string; targetFingerprint: string;
  fields: Record<string, DtsFieldType>;
  sourceCount: number; targetCount: number; insertCount: number; updateCount: number; skipCount: number;
  selectedBytes: number; targetFreeBytes: number; requiredFreeBytes: number;
  /** Bounded stable identities; data values and credentials never enter control-plane state. */
  keys: string[]; selectedDigest: string; approvedBy: DtsActor;
  sourceContract: DtsContract; targetContract: DtsContract;
  redisEntries?: DtsRedisEntry[];
  rabbitObjects?: DtsRabbitObject[];
}
export type DtsRunStatus = 'preparing' | 'submitting' | 'running' | 'verifying' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'uncertain';
export interface DtsRun {
  id: string; projectId: string; plan: DtsPlan; status: DtsRunStatus;
  engine: DtsEngineBinding; engineJobId: string; configDigest?: string;
  createdAt: string; updatedAt: string; finishedAt?: string;
  message: string; appliedCount: number; attempts: number;
  stopRequested?: 'pause' | 'cancel'; idempotencyKey: string; actor: DtsActor; schedulerId?: string;
}
export interface DtsPolicy {
  id: string; projectId: string; sourceId: string; targetId: string; enabled: boolean;
  /** New identities are discovered promptly; existing identities use a separate daily job. */
  newAccountsEverySeconds: number; reconcileHour: number; timezone: 'Asia/Shanghai';
  nextDiscoveryAt: string; lastReconcileDate?: string; lastRunId?: string; lastError?: string; actor: DtsActor;
}
export const DTS_TOOLS = [
  'cds_dts_connections', 'cds_dts_plan', 'cds_dts_start', 'cds_dts_runs', 'cds_dts_control', 'cds_dts_policies',
] as const;
