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

// ssh2 是 CommonJS。这里必须走**默认导入**再取 .utils，不能写
// `import { utils } from 'ssh2'`——tsc 编得过、vitest 也跑得过（它自己做 interop），
// 但产物是真 ESM，Node 加载时会抛
// `SyntaxError: Named export 'utils' not found`，整个 CDS 起不来。
// 2026-07-29 就是这么把 CDS Self 预览打挂的：类型检查零错误、4568 条测试全绿、容器起不来。
// release-service.ts 的 loadSsh2() 用 `mod.Client || mod.default?.Client` 处理同一件事。
import ssh2 from 'ssh2';

import type { StateService } from '../state.js';
import type { RemoteHost } from '../../types.js';
import { sealToken, unsealToken } from '../../infra/secret-seal.js';

const { parseKey } = ssh2.utils;

/** 用于 UI 展示的安全版 RemoteHost：剔除一切密文 + 仅保留 fingerprint。 */
export interface RemoteHostPublicView {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKeyFingerprint: string;
  hasPassphrase: boolean;
  /** 存量数据无 sshAuthMethod，一律按 private-key 解读。 */
  authMethod: 'private-key' | 'password';
  /**
   * CDS 生成密钥对时的 OpenSSH 公钥。公钥不是秘密，照原样给前端，
   * 用户随时能回来复制它去远端 authorized_keys。
   */
  publicKey?: string;
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
  /** 明文 PEM；service 内 seal。与 sshPassword / generateKeyPair 三选一。 */
  sshPrivateKey?: string;
  /** 私钥口令（可选，明文）。 */
  sshPassphrase?: string;
  /** SSH 登录密码（明文，service 内 seal）。与 sshPrivateKey / generateKeyPair 三选一。 */
  sshPassword?: string;
  /**
   * 由 CDS 生成一对密钥：私钥留在 CDS（seal 后落库），公钥回传给调用方去授权。
   *
   * 存在的理由是「手上什么都没有」的那种人：不必先去本地 ssh-keygen、
   * 再把私钥粘进浏览器（那等于让私钥多走一趟网络）。
   */
  generateKeyPair?: boolean;
  tags?: string[];
  isEnabled?: boolean;
  createdBy?: string;
}

/** 计算 RemoteHost 凭据指纹（不依赖 ssh-keygen，用 SHA256 前 16 hex 即可识别）。 */
export function fingerprintPrivateKey(plain: string): string {
  const hash = crypto.createHash('sha256').update(plain).digest('hex');
  return hash.slice(0, 16);
}

/**
 * 密码认证主机的凭据标识。
 *
 * **不能**复用 fingerprintPrivateKey：那是无盐 sha256 截 64 位，而这个值经
 * `GET /api/cds-system/remote-hosts` 公开返回、且不按项目作用域过滤。私钥有几百比特
 * 熵，截断哈希对它没有实际意义上的可逆性；口令没有——低权限凭据读到这个指纹，就能
 * 拿一本字典离线比对，猜中即得到生产机的 SSH 口令。
 *
 * 所以这里返回一枚**与密钥材料无关**的随机串：它仍然满足「同一台主机换过凭据没有」
 * 这个 UI 用途（换凭据即换值），但不再是任何东西的校验子。
 */
export function opaqueCredentialRef(): string {
  return crypto.randomBytes(8).toString('hex');
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
    authMethod: host.sshAuthMethod ?? 'private-key',
    publicKey: host.sshPublicKey,
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
  privateKey?: string;
  passphrase?: string;
  password?: string;
} {
  return {
    // 私钥与密码二选一，所以两边都可能是 undefined。ssh2 的 connect 对
    // undefined 字段是「当这项没配」，不会当成空凭据去试。
    privateKey: host.sshPrivateKeyEncrypted
      ? unsealToken(host.sshPrivateKeyEncrypted)
      : undefined,
    passphrase: host.sshPassphraseEncrypted
      ? unsealToken(host.sshPassphraseEncrypted)
      : undefined,
    password: host.sshPasswordEncrypted
      ? unsealToken(host.sshPasswordEncrypted)
      : undefined,
  };
}

/**
 * 生成一对可直接喂给 ssh2 的 RSA 密钥。
 *
 * 为什么是 RSA-3072 的 PKCS#1 PEM，而不是更时髦的 ed25519：
 * ssh2 的 parseKey 不认 Node crypto 导出的 PKCS#8 / SPKI（实测两种都报
 * Unsupported key format），只认传统 PEM。这不是审美选择，是兼容性事实。
 * 容器里也没有 ssh-keygen 可用，所以公钥用 ssh2 自己的 getPublicSSH() 编码，
 * 不手搓 OpenSSH wire format。
 */
export function generateSshKeyPair(comment = 'cds'): { privateKey: string; publicKey: string } {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const parsed = parseKey(privateKey);
  if (parsed instanceof Error) {
    throw new Error(`生成的密钥 ssh2 无法解析：${parsed.message}`);
  }
  const publicKey = `${parsed.type} ${parsed.getPublicSSH().toString('base64')} ${comment}`;
  return { privateKey, publicKey };
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

    const wantsGenerated = input.generateKeyPair === true;
    // 只用 trim 判空，落库一律存原文：PEM 的尾部换行是格式的一部分，
    // 有些解析器少了它就报 "Cannot parse privateKey"，而这种错发生在
    // 半年后的一次发布上，没人会想到是当初存的时候被 trim 掉了。
    const pastedKey = input.sshPrivateKey?.trim() ? input.sshPrivateKey : undefined;
    const password = input.sshPassword?.trim() ? input.sshPassword : undefined;
    // 三种接法必须恰好选一种。多选不报错的话，静默的优先级会变成隐藏规则：
    // 用户以为填了密码，实际连的是那把粘进来的旧私钥。
    const chosen = [wantsGenerated, Boolean(pastedKey), Boolean(password)].filter(Boolean).length;
    if (chosen === 0) {
      throw new Error('需要一种认证方式：粘贴私钥、填写密码，或让 CDS 生成密钥对');
    }
    if (chosen > 1) {
      throw new Error('认证方式只能选一种：粘贴私钥、填写密码，或让 CDS 生成密钥对');
    }

    const id = crypto.randomBytes(8).toString('hex');
    const generated = wantsGenerated
      ? generateSshKeyPair(`cds-${input.name.trim() || id}`)
      : null;
    const privateKey = generated?.privateKey ?? pastedKey;
    // 私钥才做内容指纹；密码主机走与密钥材料无关的随机标识（见 opaqueCredentialRef）。
    const fingerprint = privateKey ? fingerprintPrivateKey(privateKey) : opaqueCredentialRef();
    // 密码认证下忽略口令：口令是解私钥用的，此时没有私钥可解，存了只会让
    // 公开视图报出一个不存在的 hasPassphrase。
    const sealedPass = input.sshPassphrase && !password ? sealToken(input.sshPassphrase) : undefined;

    const entity: RemoteHost = {
      id,
      name: input.name.trim(),
      host: input.host.trim(),
      sshPort: input.sshPort && input.sshPort > 0 ? input.sshPort : 22,
      sshUser: input.sshUser.trim(),
      sshPrivateKeyEncrypted: privateKey ? sealToken(privateKey) : undefined,
      sshPrivateKeyFingerprint: fingerprint,
      sshPassphraseEncrypted: sealedPass,
      sshPasswordEncrypted: password ? sealToken(password) : undefined,
      sshAuthMethod: password ? 'password' : 'private-key',
      sshPublicKey: generated?.publicKey,
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
    patch: Partial<Omit<RemoteHostInput, 'sshPrivateKey' | 'sshPassphrase' | 'sshPassword' | 'generateKeyPair'>> & {
      /** 重置私钥时传明文，service 自行 seal。 */
      sshPrivateKey?: string;
      sshPassphrase?: string;
      /** 改用密码认证时传明文，service 自行 seal。 */
      sshPassword?: string;
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

    // 换凭据即换认证方式：留着另一种的密文会让「我明明改成密码了」变成
    // 一次静默回退到旧私钥，所以对侧一律清空。
    if (patch.sshPrivateKey?.trim()) {
      fields.sshPrivateKeyFingerprint = fingerprintPrivateKey(patch.sshPrivateKey);
      fields.sshPrivateKeyEncrypted = sealToken(patch.sshPrivateKey);
      fields.sshPasswordEncrypted = undefined;
      fields.sshAuthMethod = 'private-key';
    } else if (patch.sshPassword?.trim()) {
      fields.sshPrivateKeyFingerprint = opaqueCredentialRef();
      fields.sshPasswordEncrypted = sealToken(patch.sshPassword);
      fields.sshPrivateKeyEncrypted = undefined;
      fields.sshPublicKey = undefined;
      fields.sshAuthMethod = 'password';
      // 口令属于「那把已经被清掉的私钥」。留着它，公开视图会继续报 hasPassphrase，
      // 而且之后换回私钥认证时这枚陈年口令会被拿去解新私钥，认证失败还查不出原因。
      fields.sshPassphraseEncrypted = undefined;
    }

    const switchedToPassword = fields.sshAuthMethod === 'password';
    if (patch.clearPassphrase || switchedToPassword) {
      // switchedToPassword 也走这里，且优先于下面的写入：口令是私钥的附属品，
      // 「改成密码认证」和「同时给一个口令」是自相矛盾的输入，按前者解读。
      fields.sshPassphraseEncrypted = undefined;
    } else if (patch.sshPassphrase !== undefined && patch.sshPassphrase !== '') {
      fields.sshPassphraseEncrypted = sealToken(patch.sshPassphrase);
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
