// 设计执行协议 map-design-executor-v1 的请求契约（POST /v1/tasks）。
// 协议说明见 doc/spec.platform.design-runtime.protocol.md；本文件是它在代码里的唯一判据。
import { publicTransfer } from './artifact/public-package.js';
import { AgentWorkspaceRuntimeError } from './errors.js';
import type { DesignTaskInput } from './executor.js';
import {
  SESSION_ID_RE,
  derivePreviewUrl,
  normalizeWorkspaceTransfer,
  validateModelAuthority,
  validateTransferUrl,
  type OpenDesignModelAuthority,
} from './workspace/transfer.js';
import { sha256 } from './workspace/primitives.js';

export const EXECUTOR_PROTOCOL = 'map-design-executor-v1';
const MAP_DESIGN_COMMAND_SCHEMA = 'map-design-artifact-command-v2';
const DEFAULT_TASK_TIMEOUT_SECONDS = 900;
const MIN_TASK_TIMEOUT_SECONDS = 30;
const MAX_TASK_TIMEOUT_SECONDS = 7_200;

export interface NormalizedTaskRequest extends DesignTaskInput {
  /** 第几次尝试。同一 taskId 只有在上一次尝试以失败 / 取消结束后才能以更大的 attempt 重新提交。 */
  attempt: number;
  /** 不含任何密钥的请求指纹：同一 taskId + 同一 attempt 的重复提交靠它判断是不是同一个请求。 */
  fingerprint: string;
}

function invalid(message: string): never {
  throw new AgentWorkspaceRuntimeError('task_request_invalid', message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * MAP 的任务信封（DesignArtifactPromptBuilder.BuildRemoteEnvelope 产出的 map-design-artifact-command-v2）。
 * 服务按 MAP 的字段顺序原样序列化成交给 OpenDesign 的第一轮指令，与经 CDS 转交时的文本一致。
 */
function normalizeEnvelope(value: unknown, taskId: string): string {
  const envelope = record(value, 'envelope');
  if (envelope.schemaVersion !== MAP_DESIGN_COMMAND_SCHEMA) invalid(`envelope.schemaVersion must be ${MAP_DESIGN_COMMAND_SCHEMA}`);
  if (envelope.runId !== taskId) invalid('envelope.runId must equal taskId');
  if (envelope.workspaceTask !== '/workspace/brief/task.json') invalid('envelope.workspaceTask must be /workspace/brief/task.json');
  if (typeof envelope.command !== 'string' || !envelope.command.trim()) invalid('envelope.command is required');
  if (envelope.runtimeProtocol !== undefined && typeof envelope.runtimeProtocol !== 'string') {
    invalid('envelope.runtimeProtocol must be a string when present');
  }
  const serialized = JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    ...(envelope.runtimeProtocol !== undefined ? { runtimeProtocol: envelope.runtimeProtocol } : {}),
    runId: envelope.runId,
    workspaceTask: envelope.workspaceTask,
    command: envelope.command,
  });
  if (serialized.length > 12_000) invalid('envelope must serialize to at most 12000 characters');
  return serialized;
}

function normalizeModel(value: unknown): OpenDesignModelAuthority {
  const model = record(value, 'model');
  if (typeof model.baseUrl !== 'string' || typeof model.apiKey !== 'string' || typeof model.model !== 'string') {
    invalid('model.baseUrl, model.apiKey, and model.model must be strings');
  }
  if (model.protocol !== 'openai') invalid('model.protocol must be openai');
  if (model.apiKey.length > 8_192 || /[\0\r\n]/.test(model.apiKey)) invalid('model.apiKey is malformed');
  if (model.model.length > 200) invalid('model.model is too long');
  return { baseUrl: model.baseUrl, protocol: 'openai', apiKey: model.apiKey, model: model.model };
}

export function normalizeTaskRequest(body: unknown): NormalizedTaskRequest {
  const request = record(body, 'request body');
  const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : '';
  if (!SESSION_ID_RE.test(taskId)) invalid('taskId must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$');
  const attempt = request.attempt === undefined ? 1 : request.attempt;
  if (!Number.isSafeInteger(attempt) || Number(attempt) < 1 || Number(attempt) > 100) invalid('attempt must be an integer in [1, 100]');
  const rawTransfer = record(request.transfer, 'transfer');
  const { previewUrl: rawPreviewUrl, ...transferFields } = rawTransfer;
  const transfer = normalizeWorkspaceTransfer(transferFields);
  let previewUrl: string | undefined;
  if (rawPreviewUrl !== undefined && rawPreviewUrl !== null) {
    const parsed = validateTransferUrl(rawPreviewUrl, 'transfer.previewUrl');
    if (parsed.origin !== new URL(transfer.resultCommitUrl).origin) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_transfer_origin_mismatch',
        'transfer.previewUrl must share the MAP origin of the other transfer URLs',
      );
    }
    previewUrl = parsed.toString();
  } else {
    previewUrl = derivePreviewUrl(transfer.resultCommitUrl);
  }
  const model = normalizeModel(request.model);
  validateModelAuthority(model, transfer.inputPackageUrl);
  const timeoutSeconds = request.timeoutSeconds === undefined ? DEFAULT_TASK_TIMEOUT_SECONDS : request.timeoutSeconds;
  if (
    !Number.isSafeInteger(timeoutSeconds)
    || Number(timeoutSeconds) < MIN_TASK_TIMEOUT_SECONDS
    || Number(timeoutSeconds) > MAX_TASK_TIMEOUT_SECONDS
  ) {
    invalid(`timeoutSeconds must be an integer in [${MIN_TASK_TIMEOUT_SECONDS}, ${MAX_TASK_TIMEOUT_SECONDS}]`);
  }
  const instruction = normalizeEnvelope(request.envelope, taskId);
  const fingerprint = sha256(JSON.stringify({
    taskId,
    attempt,
    transfer: publicTransfer(transfer),
    previewUrl: previewUrl ?? null,
    model: { baseUrl: model.baseUrl, protocol: model.protocol, model: model.model },
    timeoutSeconds,
    instruction,
  }));
  return {
    taskId,
    attempt: Number(attempt),
    fingerprint,
    transfer,
    ...(previewUrl ? { previewUrl } : {}),
    model,
    timeoutSeconds: Number(timeoutSeconds),
    instruction,
  };
}
