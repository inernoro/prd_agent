import crypto from 'node:crypto';
import fs from 'node:fs';

import type { ServerEventLogSink } from './server-event-log-store.js';
import {
  defaultEnvFilePath,
  EnvFileBusyError,
  readEnvFile,
  updateEnvFileWhileLocked,
  withEnvFileLock,
} from './env-file.js';

const SEALED_STORAGE_ENV_KEY = 'CDS_SECRET_KEY';

export interface SealedStorageStatus {
  enabled: boolean;
  fingerprint: string | null;
  persisted: boolean;
  restartRequired: boolean;
}

export interface SealedStorageBootstrapDeps {
  env?: NodeJS.ProcessEnv;
  envFilePath?: () => string;
  randomBytes?: (size: number) => Buffer;
  audit?: ServerEventLogSink | null;
}

export class SealedStorageBootstrapError extends Error {
  constructor(
    public readonly code:
      | 'sealed_storage_key_conflict'
      | 'sealed_storage_key_invalid'
      | 'sealed_storage_initialization_busy'
      | 'sealed_storage_persist_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SealedStorageBootstrapError';
  }
}

function normalizedSecret(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function assertPersistableSecret(secret: string): void {
  if (secret.length < 32 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new SealedStorageBootstrapError(
      'sealed_storage_key_invalid',
      '已有密封密钥不满足持久化要求，系统拒绝激活或覆盖。',
    );
  }
}

function fingerprint(secret: string | null): string | null {
  if (!secret) return null;
  return `sha256:${crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16)}`;
}

function secretFromEnvFile(envFilePath: string): string | null {
  const line = readEnvFile(envFilePath).find(
    (entry) => entry.type === 'export' && entry.key === SEALED_STORAGE_ENV_KEY,
  );
  return normalizedSecret(line?.value);
}

function statusFrom(activeSecret: string | null, diskSecret: string | null): SealedStorageStatus {
  const enabled = activeSecret !== null;
  const persisted = diskSecret !== null && activeSecret === diskSecret;
  return {
    enabled,
    fingerprint: fingerprint(activeSecret ?? diskSecret),
    persisted,
    restartRequired: !enabled && diskSecret !== null,
  };
}

export function describeSealedStorage(
  deps: Pick<SealedStorageBootstrapDeps, 'env' | 'envFilePath'> = {},
): SealedStorageStatus {
  const env = deps.env ?? process.env;
  const envFilePath = (deps.envFilePath ?? defaultEnvFilePath)();
  return statusFrom(
    normalizedSecret(env[SEALED_STORAGE_ENV_KEY]),
    secretFromEnvFile(envFilePath),
  );
}

function auditInitialization(
  audit: ServerEventLogSink | null | undefined,
  status: SealedStorageStatus,
  result: 'created' | 'activated' | 'persisted' | 'unchanged',
): void {
  try {
    audit?.record({
      category: 'system',
      severity: 'info',
      source: 'sealed-storage-bootstrap',
      action: 'sealed-storage.initialize',
      message: 'CDS sealed storage initialization completed',
      status: result,
      details: { ...status, result },
    });
  } catch {
    // The durable key is already active at this point. A best-effort audit
    // sink failure must not turn a successful initialization into a false
    // API failure that invites the operator to retry a completed mutation.
  }
}

/**
 * Initialize CDS field-level sealed storage without accepting or returning a
 * plaintext key. Existing runtime or on-disk keys are reused and never
 * replaced. A new 32-byte key is generated only when neither source has one.
 */
export function initializeSealedStorage(
  deps: SealedStorageBootstrapDeps = {},
): SealedStorageStatus {
  const env = deps.env ?? process.env;
  const envFilePath = (deps.envFilePath ?? defaultEnvFilePath)();
  try {
    return withEnvFileLock(envFilePath, () => {
      // Re-read both sources only after owning the shared env-file lock. This
      // is the CAS boundary for bootstrap and every other env update.
      const activeSecret = normalizedSecret(env[SEALED_STORAGE_ENV_KEY]);
      const diskSecret = secretFromEnvFile(envFilePath);

      if (activeSecret && diskSecret && activeSecret !== diskSecret) {
        throw new SealedStorageBootstrapError(
          'sealed_storage_key_conflict',
          '运行时密封密钥与 .cds.env 不一致，系统拒绝覆盖任一已有密钥。',
        );
      }

      const chosenSecret = activeSecret ?? diskSecret
        ?? (deps.randomBytes ?? crypto.randomBytes)(32).toString('hex');
      assertPersistableSecret(chosenSecret);
      const result = activeSecret && diskSecret
        ? 'unchanged'
        : activeSecret
          ? 'persisted'
          : diskSecret
            ? 'activated'
            : 'created';

      if (!diskSecret) {
        updateEnvFileWhileLocked(envFilePath, { [SEALED_STORAGE_ENV_KEY]: chosenSecret });
      } else if (process.platform !== 'win32') {
        fs.chmodSync(envFilePath, 0o600);
        const existingFd = fs.openSync(envFilePath, 'r');
        try { fs.fsyncSync(existingFd); } finally { fs.closeSync(existingFd); }
      }
      const verifiedDiskSecret = secretFromEnvFile(envFilePath);
      if (verifiedDiskSecret !== chosenSecret) {
        throw new SealedStorageBootstrapError(
          'sealed_storage_persist_failed',
          '密封存储持久化校验失败，运行时配置保持原状。',
        );
      }

      // Persist, fsync and verify first, then activate. A failed durable write
      // therefore never leaves this process using a key that cannot restart.
      env[SEALED_STORAGE_ENV_KEY] = chosenSecret;
      const status = statusFrom(chosenSecret, verifiedDiskSecret);
      auditInitialization(deps.audit, status, result);
      return status;
    });
  } catch (error) {
    if (error instanceof SealedStorageBootstrapError) throw error;
    if (error instanceof EnvFileBusyError) {
      throw new SealedStorageBootstrapError(
        'sealed_storage_initialization_busy',
        '另一个 CDS 进程正在更新系统环境文件，本次初始化已安全终止。',
      );
    }
    throw new SealedStorageBootstrapError(
      'sealed_storage_persist_failed',
      '密封存储初始化未持久化，运行时配置保持原状。',
    );
  }
}
