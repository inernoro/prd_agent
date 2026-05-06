/**
 * RemoteHostService — shared-service 远程 SSH 主机的高层管理：
 *
 *   - 录入/校验私钥，seal 后写入 state
 *   - 计算 fingerprint（明文 SHA256 前 16 hex）供 UI 展示
 *   - 解密私钥供 SidecarDeployer 使用（接口对内不对外暴露明文）
 *   - 连接测试（ssh exec "echo ok"）by SidecarDeployer，本服务只负责状态记录
 *
 * 安全约束：
 *   - 任何返回到 HTTP 响应的 RemoteHost 都必须经过 redact()
 *   - 解密路径仅供 SidecarDeployer / 测试连接 流程内部使用，不导出
 */

import crypto from 'node:crypto';

import type { StateService } from '../state.js';
import type { RemoteHost } from '../../types.js';
import { sealToken, unsealToken } from '../../infra/secret-seal.js';

/** 用于 UI 展示的安全版 RemoteHost：剔除一切密文 + 仅保留 fingerprint。 */
export interface RemoteHostPublicView {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKeyFingerprint: string;
  hasPassphrase: boolean;
  tags: string[];
  isEnabled: boolean;
  createdAt: string;
  createdBy?: string;
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestError?: string;
}

export interface RemoteHostInput {
  name: string;
  host: string;
  sshPort?: number;
  sshUser: string;
  /** 明文 PEM；service 内 seal。 */
  sshPrivateKey: string;
  /** 私钥口令（可选，明文）。 */
  sshPassphrase?: string;
  tags?: string[];
  isEnabled?: boolean;
  createdBy?: string;
}

/** 计算 RemoteHost 凭据指纹（不依赖 ssh-keygen，用 SHA256 前 16 hex 即可识别）。 */
export function fingerprintPrivateKey(plain: string): string {
  const hash = crypto.createHash('sha256').update(plain).digest('hex');
  return hash.slice(0, 16);
}

/** 把可能 sealed 的 RemoteHost 转为只暴露公开字段的视图。 */
export function redactRemoteHost(host: RemoteHost): RemoteHostPublicView {
  return {
    id: host.id,
    name: host.name,
    host: host.host,
    sshPort: host.sshPort,
    sshUser: host.sshUser,
    sshPrivateKeyFingerprint: host.sshPrivateKeyFingerprint,
    hasPassphrase: !!host.sshPassphraseEncrypted,
    tags: host.tags,
    isEnabled: host.isEnabled,
    createdAt: host.createdAt,
    createdBy: host.createdBy,
    lastTestedAt: host.lastTestedAt,
    lastTestOk: host.lastTestOk,
    lastTestError: host.lastTestError,
  };
}

/**
 * 解密 RemoteHost 的 SSH 凭据。仅供 SidecarDeployer / 连接测试流程内部使用。
 * 返回的明文不应再次落盘 / 出现在 HTTP 响应 / 出现在日志。
 */
export function decryptRemoteHostSecrets(host: RemoteHost): {
  privateKey: string;
  passphrase?: string;
} {
  return {
    privateKey: unsealToken(host.sshPrivateKeyEncrypted),
    passphrase: host.sshPassphraseEncrypted
      ? unsealToken(host.sshPassphraseEncrypted)
      : undefined,
  };
}

export class RemoteHostService {
  constructor(private readonly stateService: StateService) {}

  list(): RemoteHostPublicView[] {
    return this.stateService.getRemoteHosts().map(redactRemoteHost);
  }

  get(id: string): RemoteHostPublicView | undefined {
    const h = this.stateService.getRemoteHost(id);
    return h ? redactRemoteHost(h) : undefined;
  }

  /** 内部使用 —— 拿原始 RemoteHost（含密文）。 */
  getRaw(id: string): RemoteHost | undefined {
    return this.stateService.getRemoteHost(id);
  }

  create(input: RemoteHostInput): RemoteHostPublicView {
    if (!input.name?.trim()) throw new Error('name is required');
    if (!input.host?.trim()) throw new Error('host is required');
    if (!input.sshUser?.trim()) throw new Error('sshUser is required');
    if (!input.sshPrivateKey?.trim()) throw new Error('sshPrivateKey is required');

    const id = crypto.randomBytes(8).toString('hex');
    const fingerprint = fingerprintPrivateKey(input.sshPrivateKey);
    const sealedKey = sealToken(input.sshPrivateKey);
    const sealedPass = input.sshPassphrase ? sealToken(input.sshPassphrase) : undefined;

    const entity: RemoteHost = {
      id,
      name: input.name.trim(),
      host: input.host.trim(),
      sshPort: input.sshPort && input.sshPort > 0 ? input.sshPort : 22,
      sshUser: input.sshUser.trim(),
      sshPrivateKeyEncrypted: typeof sealedKey === 'string' ? sealedKey : JSON.stringify(sealedKey),
      sshPrivateKeyFingerprint: fingerprint,
      sshPassphraseEncrypted: sealedPass
        ? typeof sealedPass === 'string'
          ? sealedPass
          : JSON.stringify(sealedPass)
        : undefined,
      tags: (input.tags || []).map(t => t.trim()).filter(Boolean),
      isEnabled: input.isEnabled !== false,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };

    this.stateService.addRemoteHost(entity);
    return redactRemoteHost(entity);
  }

  update(
    id: string,
    patch: Partial<Omit<RemoteHostInput, 'sshPrivateKey' | 'sshPassphrase'>> & {
      /** 重置私钥时传明文，service 自行 seal。 */
      sshPrivateKey?: string;
      sshPassphrase?: string;
      /** 显式设为 null/empty 表示清空口令。 */
      clearPassphrase?: boolean;
    },
  ): RemoteHostPublicView {
    const existing = this.stateService.getRemoteHost(id);
    if (!existing) throw new Error(`RemoteHost not found: ${id}`);

    const fields: Partial<RemoteHost> = {};
    if (patch.name !== undefined) fields.name = patch.name.trim();
    if (patch.host !== undefined) fields.host = patch.host.trim();
    if (patch.sshPort !== undefined && patch.sshPort > 0) fields.sshPort = patch.sshPort;
    if (patch.sshUser !== undefined) fields.sshUser = patch.sshUser.trim();
    if (patch.tags !== undefined)
      fields.tags = patch.tags.map(t => t.trim()).filter(Boolean);
    if (patch.isEnabled !== undefined) fields.isEnabled = patch.isEnabled;

    if (patch.sshPrivateKey?.trim()) {
      fields.sshPrivateKeyFingerprint = fingerprintPrivateKey(patch.sshPrivateKey);
      const sealed = sealToken(patch.sshPrivateKey);
      fields.sshPrivateKeyEncrypted = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
    }

    if (patch.clearPassphrase) {
      fields.sshPassphraseEncrypted = undefined;
    } else if (patch.sshPassphrase !== undefined && patch.sshPassphrase !== '') {
      const sealed = sealToken(patch.sshPassphrase);
      fields.sshPassphraseEncrypted = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
    }

    const merged = this.stateService.updateRemoteHost(id, fields);
    return redactRemoteHost(merged);
  }

  remove(id: string): boolean {
    return this.stateService.removeRemoteHost(id);
  }

  recordTestResult(id: string, ok: boolean, error?: string): RemoteHostPublicView {
    const merged = this.stateService.updateRemoteHost(id, {
      lastTestedAt: new Date().toISOString(),
      lastTestOk: ok,
      lastTestError: ok ? undefined : error,
    });
    return redactRemoteHost(merged);
  }
}
