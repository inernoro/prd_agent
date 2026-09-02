/**
 * credential-self-check — 「我这把凭据到底怎么了」的唯一判据。
 *
 * ## 为什么需要它
 *
 * CDS 里同时存在五种彼此独立的凭据面（用户级 `cdsu_`、项目级 `cdsp_`、全局
 * `cdsg_`、静态访问密钥、系统互联 `ct_`），外加一层与凭据无关的运维审批记忆。
 * 任意一层失配，
 * 今天都塌缩成同一句「未授权」。于是持有者只能猜，猜不出就来问管理员，管理员
 * 去项目卡上一看「key 明明还在」——因为**被撤掉的和他去看的，压根不是同一样
 * 东西**。这就是「动不动 401，CDS 很不好用」的直接来源。
 *
 * 本模块把「未授权」拆成可分辨的几种结论，让持有者**自己**查得出来：
 *
 * | 结论 | 含义 | 下一步 |
 * |---|---|---|
 * | active | 有效，属于哪个项目、何时签的 | 401 不是凭据问题，往别处查 |
 * | revoked | 被吊销过，何时 | 找项目负责人重新签发 |
 * | expired | 到期了（身份层的凭据短命、用即续） | 项目级跑自愈；用户级找管理员重签 |
 * | principal-disabled | 凭据没问题，是持有它的主体被停用了 | 重新签发无用，先恢复主体 |
 * | grant-revoked | 主体对这个项目的授权被撤了 | 重新签发也进不来，先请人重新批准 |
 * | never-issued | 这个系统从没签发过这把 | 拿错实例 / 拿错钥匙 / 复制截断 |
 * | prefix-mismatch | 凭据本身有效，但项目前缀与项目当前 slug 不符 | 重新签发（见下） |
 * | not-checkable | 认得出类型，但本实例没有可比对的记录 | 明说查不了，不猜 |
 * | malformed | 形状就不对 | 复制完整了吗 |
 *
 * `prefix-mismatch` 是查证时挖出来的第六种「key 还在却用不了」：鉴权路径
 * （`StateService.findAgentKeyForAuth`）先用 `cdsp_<slug 前 12 位>_` 这段前缀
 * 定位项目、再比哈希。项目一旦改过 slug，存量密钥前缀就对不上，鉴权直接跳过
 * 它 —— 密钥没被吊销、项目卡上看得见，但每次都 401。本模块**不按前缀筛**，
 * 扫全部项目比哈希，因此能把这种情况单独报出来。
 *
 * ## 安全边界
 *
 * - 入参是明文凭据，**出参绝不含明文或哈希**，也不回显凭据本身。
 * - `never-issued` 只回答「没见过」，不透露任何项目信息。
 * - 命中时只给项目 id / slug / 签发与吊销时间这类持有者本就该知道的事实。
 * - 这不是可枚举的预言机：凭据是 24 字节随机串，猜中的概率与直接猜密钥相同；
 *   而拿一把真凭据换来的「revoked」，本来试一次请求也能得到。
 *
 * 纯函数：不读文件、不查 DB、不碰 docker，可直接单测。
 */

import crypto from 'node:crypto';

import { credentialUsability } from './identity.js';

/** 凭据类型。与 server.ts 的鉴权分支一一对应。 */
export type CredentialKind =
  /** 项目级 `cdsp_<slug 前 12 位>_<随机段>`：绑死一个项目 */
  | 'project'
  /** 全局 `cdsg_<随机段>`：带显式权限描述，可建项目 */
  | 'global'
  /** 系统互联 `ct_<随机段>`：发给外部系统，只能到达白名单路由 */
  | 'connection'
  /** 用户级 `cdsu_<随机段>`：认人不认项目，只授权不直接操作 */
  | 'user'
  /** 静态访问密钥：给自动化脚本调 API */
  | 'static'
  /** 认不出来 */
  | 'unrecognized';

export type CredentialStatus =
  | 'active'
  | 'revoked'
  /** 身份层的凭据是短命的（用即续）。到期与被吊销是两回事，下一步也不同。 */
  | 'expired'
  /** 凭据本身好好的，是持有它的那个主体被停用了 —— 重新签发也没用。 */
  | 'principal-disabled'
  /** 凭据与主体都没问题，是这个主体对该项目的授权被撤了。 */
  | 'grant-revoked'
  | 'never-issued'
  | 'prefix-mismatch'
  | 'not-checkable'
  | 'malformed';

/** state 里一条已存储的凭据（只取判定需要的字段）。 */
export interface StoredCredential {
  id: string;
  label?: string;
  /** 明文的 sha256 十六进制 */
  hash: string;
  createdAt?: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** 身份层签发的凭据带到期时间；存量凭据没有这个字段 = 永不过期。 */
  expiresAt?: string;
  /** 归属主体。存量凭据没有主体（自检里显示为「未认领」）。 */
  principalId?: string;
}

/** 判定所需的全部事实。由路由从 StateService / config 组装后传入。 */
export interface CredentialFacts {
  projects: Array<{
    id: string;
    slug: string;
    name?: string;
    /** 含已吊销条目 —— 少了它就分不出 revoked 与 never-issued */
    agentKeys?: StoredCredential[];
  }>;
  globalAgentKeys?: StoredCredential[];
  /**
   * 用户级凭据（`cdsu_`）。含已吊销条目，理由与 agentKeys 相同。
   * undefined = 本实例还没有身份层记录，此时 `cdsu_` 只能报 not-checkable。
   */
  userCredentials?: StoredCredential[];
  /** 主体状态表，用来把「凭据没问题、人被停用了」单独报出来。 */
  principals?: Array<{ id: string; name?: string; status: string }>;
  /**
   * 项目授权表（含已撤销条目）。鉴权路径会因为授权被撤而拒绝一把没吊销、没过期
   * 的项目级凭据 —— 自检拿不到这份事实，就会对着**它自己造成的那个 401** 回答
   * 「有效」，正是这个端点最不该给出的答案。
   */
  grants?: Array<{ principalId: string; projectId: string; revokedAt?: string }>;
  /**
   * 静态访问密钥的 sha256 集合。undefined = 本实例没配 / 调用方没提供，
   * 此时静态密钥只能报 not-checkable，不许猜。
   */
  staticKeyHashes?: string[];
  /**
   * 系统互联凭据的 sha256 集合。同上，undefined 即 not-checkable。
   */
  connectionTokenHashes?: string[];
}

export interface CredentialSelfCheckResult {
  kind: CredentialKind;
  status: CredentialStatus;
  /** 一句人话结论，可直接展示给持有者 */
  summary: string;
  /** 具体的下一步动作，不写「请检查配置」这种空话 */
  nextStep: string;
  /** 这把凭据能到达哪些面（人话），与实际鉴权分支对应 */
  reach: string;
  /** 命中时才有 */
  keyId?: string;
  projectId?: string;
  projectSlug?: string;
  projectName?: string;
  label?: string;
  issuedAt?: string;
  issuedBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

const PROJECT_PREFIX = 'cdsp_';
const GLOBAL_PREFIX = 'cdsg_';
const CONNECTION_PREFIX = 'ct_';
const USER_PREFIX = 'cdsu_';
/** 项目 slug 参与 `cdsp_` 前缀的长度，与 state.ts 的签发/鉴权保持一致。 */
export const PROJECT_SLUG_HEAD_LENGTH = 12;

/** sha256 十六进制。与签发和鉴权路径同一口径。 */
export function hashCredential(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * 定长比较两个十六进制哈希。长度不等或十六进制非法一律判否 ——
 * 与 `StateService.findAgentKeyForAuth` 的做法逐字对齐，避免两处口径漂移。
 */
export function hashesEqual(storedHex: string, presentedHex: string): boolean {
  try {
    const a = Buffer.from(storedHex, 'hex');
    const b = Buffer.from(presentedHex, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 该凭据类型能到达什么（人话）。文案与 doc/plan 的四类凭据表一致。 */
function reachOf(kind: CredentialKind): string {
  switch (kind) {
    case 'project':
      return '绑定单个项目：可操作该项目的分支、配置与部署；不能创建新项目。';
    case 'global':
      return '带显式权限描述：能否创建项目、可操作哪些项目由签发时的作用域决定。';
    case 'connection':
      return '系统互联：只能到达一张白名单路由（页面代理与只读验收报告），不共享管理员权限面。';
    case 'user':
      return '用户级凭证：只能建项目、列项目、为已授权项目签发项目级凭证；不能删分支、改配置、跑运维指令。';
    case 'static':
      return '静态访问密钥：给自动化脚本调 CDS API 用。';
    default:
      return '无法判断这把凭据属于哪一类。';
  }
}

/** 从明文前缀判定类型。不做任何比对，纯形状识别。 */
export function classifyCredential(plaintext: string): CredentialKind {
  const value = (plaintext || '').trim();
  if (!value) return 'unrecognized';
  // cdsu_ 必须排在 cdsp_/cdsg_ 之前判断吗？不必——三者互不为前缀。但顺序写在
  // 一起，避免日后新增 cds* 面时漏掉这一层。
  if (value.startsWith(USER_PREFIX)) return 'user';
  if (value.startsWith(PROJECT_PREFIX)) return 'project';
  if (value.startsWith(GLOBAL_PREFIX)) return 'global';
  if (value.startsWith(CONNECTION_PREFIX)) return 'connection';
  // 静态访问密钥没有约定前缀。只有在调用方提供了可比对的哈希时才谈得上判定，
  // 所以这里先归为 static，由主流程按 facts 决定是 active 还是 not-checkable。
  return 'static';
}

function base(kind: CredentialKind, status: CredentialStatus, summary: string, nextStep: string): CredentialSelfCheckResult {
  return { kind, status, summary, nextStep, reach: reachOf(kind) };
}

/**
 * 在一组已存储凭据里找出哈希相同的那条（**包含已吊销**）。
 *
 * 与鉴权路径的关键差别就在这里：鉴权只关心「能不能进」，所以跳过已吊销；
 * 自检要回答「这把发生了什么」，所以必须看得见已吊销的那条 —— 否则
 * 「被吊销」和「从没签发」就永远分不开，正是本模块要解决的问题。
 */
function matchStored(entries: StoredCredential[] | undefined, presentedHash: string): StoredCredential | undefined {
  for (const entry of entries || []) {
    if (hashesEqual(entry.hash, presentedHash)) return entry;
  }
  return undefined;
}

function describeStored(
  result: CredentialSelfCheckResult,
  entry: StoredCredential,
): CredentialSelfCheckResult {
  return {
    ...result,
    keyId: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.createdAt ? { issuedAt: entry.createdAt } : {}),
    ...(entry.createdBy ? { issuedBy: entry.createdBy } : {}),
    ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
    ...(entry.revokedAt ? { revokedAt: entry.revokedAt } : {}),
  };
}

/**
 * 凭据本身之外的两种「进不来」：到期、主体被停用。
 *
 * 判据不在这里重写，直接借 `identity.credentialUsability` —— 鉴权与自愈都走那一份，
 * 自检再抄一份就会漂移（存量凭据没有 expiresAt，那里刻意判为永不过期）。
 * 返回 undefined 表示这两条都不成立，交给调用方继续往下判。
 */
function deadReasonOf(
  entry: StoredCredential,
  facts: CredentialFacts,
): 'expired' | 'principal-disabled' | undefined {
  const principal = entry.principalId
    ? (facts.principals || []).find((p) => p.id === entry.principalId)
    : undefined;
  const usability = credentialUsability(
    { revokedAt: entry.revokedAt, expiresAt: entry.expiresAt },
    principal ? { status: principal.status as 'active' | 'disabled' } : undefined,
  );
  if (usability.usable) return undefined;
  if (usability.reason === 'expired') return 'expired';
  if (usability.reason === 'principal-disabled') return 'principal-disabled';
  return undefined;
}

/** 把 deadReasonOf 的结论翻成人话。项目级与用户级共用，避免两处文案漂移。 */
function describeDead(
  kind: CredentialKind,
  reason: 'expired' | 'principal-disabled',
  entry: StoredCredential,
  facts: CredentialFacts,
): CredentialSelfCheckResult {
  if (reason === 'expired') {
    return describeStored(
      base(
        kind,
        'expired',
        `这把凭据已于 ${entry.expiresAt} 到期。身份层签发的凭据是短命的（用一次自动续 90 天 / 项目级 30 天），闲置超过这个窗口就会自然到期。`,
        kind === 'user'
          ? '找管理员在「权限总览」里重新签一张用户级凭证。到期与被吊销不同，不代表你被撤了权限。'
          : '用你的用户级凭证跑一次自愈（cdscli identity heal），会自动补一张新的项目级凭据，不需要找人。',
      ),
      entry,
    );
  }
  const principal = (facts.principals || []).find((p) => p.id === entry.principalId);
  return describeStored(
    base(
      kind,
      'principal-disabled',
      `凭据本身有效且没到期，但它归属的主体「${principal?.name || entry.principalId}」已被停用 —— 该主体名下的凭据一律进不来。`,
      '这不是凭据问题，重新签发也没用。找管理员在「权限总览」里把该主体恢复为启用。',
    ),
    entry,
  );
}

/**
 * 主判据。传入明文凭据与事实快照，回答「它是什么、还在不在、为什么进不来」。
 */
export function checkCredential(plaintext: string, facts: CredentialFacts): CredentialSelfCheckResult {
  const value = (plaintext || '').trim();
  if (!value) {
    return base(
      'unrecognized',
      'malformed',
      '没有收到任何凭据。',
      '把凭据放在请求头里再试一次（x-ai-access-key 或 Authorization: Bearer <凭据>）。',
    );
  }

  const kind = classifyCredential(value);
  const presentedHash = hashCredential(value);

  if (kind === 'project') {
    // 形状先过一遍：cdsp_<slugHead>_<随机段>，少一段就是复制截断。
    const parts = value.split('_');
    if (parts.length < 3 || !parts[1]) {
      return base(
        'project',
        'malformed',
        '这看起来是项目级凭据，但形状不对（应为 cdsp_<项目前缀>_<随机段>）。',
        '多半是复制时被截断了，重新完整复制一次；仍不对就在项目卡上重新签发。',
      );
    }
    const claimedSlugHead = parts[1].toLowerCase();
    // 刻意不按前缀筛项目：前缀对不上但哈希对得上，正是 prefix-mismatch 那种情况，
    // 而它恰恰是最难自己查出来的一种（密钥没吊销、项目卡上看得见、就是进不来）。
    for (const project of facts.projects || []) {
      const entry = matchStored(project.agentKeys, presentedHash);
      if (!entry) continue;
      const actualSlugHead = (project.slug || '').slice(0, PROJECT_SLUG_HEAD_LENGTH).toLowerCase();
      const identity = {
        projectId: project.id,
        projectSlug: project.slug,
        ...(project.name ? { projectName: project.name } : {}),
      };
      if (entry.revokedAt) {
        return {
          ...describeStored(
            base(
              'project',
              'revoked',
              `这把项目级凭据属于项目「${project.name || project.slug}」，已在 ${entry.revokedAt} 被吊销。`,
              '找项目负责人在项目卡上重新签发一把；已吊销的凭据不会自己恢复。',
            ),
            entry,
          ),
          ...identity,
        };
      }
      // 顺序：先答「这把已经死了」（吊销 / 到期 / 主体停用），再答「还活着但前缀
      // 对不上」。三者的下一步各不相同，塌缩成一个就等于没拆。
      const dead = deadReasonOf(entry, facts);
      if (dead) return { ...describeDead('project', dead, entry, facts), ...identity };
      // 授权被撤：凭据本身、主体都没问题，但鉴权照样拒。少了这一档，自检会对着
      // 自己造成的 401 回答「有效」。判据与鉴权同一条（未撤销的授权算数）。
      if (entry.principalId && facts.grants) {
        const granted = facts.grants.some((g) =>
          g.principalId === entry.principalId && g.projectId === project.id && !g.revokedAt);
        if (!granted) {
          return {
            ...describeStored(
              base(
                'project',
                'grant-revoked',
                `凭据本身有效、主体也正常，但该主体对项目「${project.name || project.slug}」的授权已被撤销 —— 鉴权因此拒绝它。`,
                '这不是凭据问题，重新签发也进不来。请人重新批准一次该项目的接入；批准之后这把凭据无需更换即可恢复。',
              ),
              entry,
            ),
            ...identity,
          };
        }
      }
      if (actualSlugHead && actualSlugHead !== claimedSlugHead) {
        return {
          ...describeStored(
            base(
              'project',
              'prefix-mismatch',
              `凭据本身有效且未被吊销，但它的项目前缀是 ${claimedSlugHead}，而项目「${project.name || project.slug}」当前的 slug 前缀是 ${actualSlugHead} —— 项目改过 slug，鉴权按前缀定位项目时会跳过这把凭据。`,
              '在项目卡上重新签发一把（新凭据会带上当前 slug 前缀），再吊销这一把。这不是权限问题，重试多少次都一样。',
            ),
            entry,
          ),
          ...identity,
        };
      }
      return {
        ...describeStored(
          base(
            'project',
            'active',
            `有效的项目级凭据，属于项目「${project.name || project.slug}」。`,
            '凭据本身没问题。如果仍然被拒，看两处：这条路由是不是项目级凭据能到达的；以及运维指令的审批记忆是不是过期了（那一层与凭据无关）。',
          ),
          entry,
        ),
        ...identity,
      };
    }
    return base(
      'project',
      'never-issued',
      '本 CDS 实例从未签发过这把项目级凭据。',
      '确认三件事：连的是不是同一个 CDS 实例、凭据有没有复制完整、这把是不是别的实例上的。都不是的话走一次接入申请重新拿。',
    );
  }

  if (kind === 'user') {
    if (!facts.userCredentials) {
      return base(
        'user',
        'not-checkable',
        '认得出这是一把用户级凭证，但本实例还没有身份层记录可供比对，查不了它的状态。',
        '确认连的是不是同一个 CDS 实例；这里不猜。',
      );
    }
    const entry = matchStored(facts.userCredentials, presentedHash);
    if (!entry) {
      return base(
        'user',
        'never-issued',
        '本 CDS 实例从未签发过这把用户级凭证。',
        '确认连的是不是同一个 CDS 实例、凭证有没有复制完整；都对的话找管理员在「权限总览」里签一张。',
      );
    }
    if (entry.revokedAt) {
      return describeStored(
        base(
          'user',
          'revoked',
          `这把用户级凭证已在 ${entry.revokedAt} 被吊销。`,
          '用户级凭证被吊销时，由它签发的项目级凭据会一并级联吊销 —— 所以名下那些也别再试了。找管理员重新签一张。',
        ),
        entry,
      );
    }
    const dead = deadReasonOf(entry, facts);
    if (dead) return describeDead('user', dead, entry, facts);
    return describeStored(
      base(
        'user',
        'active',
        '有效的用户级凭证。',
        '凭证本身没问题。它只授权、不直接操作 —— 被拒多半是你打的那条路由不在它的白名单里（建项目 / 列项目 / 签项目级凭证之外的都不在），或者那个项目还没授权给你。',
      ),
      entry,
    );
  }

  if (kind === 'global') {
    const entry = matchStored(facts.globalAgentKeys, presentedHash);
    if (entry) {
      if (entry.revokedAt) {
        return describeStored(
          base(
            'global',
            'revoked',
            `这把全局凭据已在 ${entry.revokedAt} 被吊销。`,
            '注意：首次接入用的一次性「只能建项目」凭据，会在项目建成后由系统自动吊销并换发项目级凭据 —— 如果你正卡在这一步，说明换来的那把项目级凭据没被接住，重新走一次接入。',
          ),
          entry,
        );
      }
      return describeStored(
        base(
          'global',
          'active',
          '有效的全局凭据。',
          '凭据本身没问题。被拒多半是作用域不够：这把凭据的权限描述里没有你要操作的那个项目。',
        ),
        entry,
      );
    }
    return base(
      'global',
      'never-issued',
      '本 CDS 实例从未签发过这把全局凭据。',
      '确认连的是不是同一个 CDS 实例、凭据有没有复制完整。',
    );
  }

  if (kind === 'connection') {
    if (!facts.connectionTokenHashes) {
      return base(
        'connection',
        'not-checkable',
        '认得出这是一把系统互联凭据，但本次自检没有可比对的记录，查不了它的状态。',
        '到 CDS 的系统互联页面看这条连接还在不在；这里不猜。',
      );
    }
    const hit = facts.connectionTokenHashes.some((h) => hashesEqual(h, presentedHash));
    return hit
      ? base(
          'connection',
          'active',
          '有效的系统互联凭据。',
          '凭据本身没问题。被拒是因为它只能到达白名单路由 —— 管理接口对它永远是拒绝，这不是故障。',
        )
      : base(
          'connection',
          'never-issued',
          '本 CDS 实例没有这把系统互联凭据的记录。',
          '重新走一次系统互联授权。',
        );
  }

  // 静态访问密钥：没有约定前缀，只有在实例真的配了静态密钥时才谈得上比对。
  if (!facts.staticKeyHashes || facts.staticKeyHashes.length === 0) {
    return base(
      'unrecognized',
      'not-checkable',
      '这串东西不是 CDS 的项目级（cdsp_）、全局（cdsg_）或系统互联（ct_）凭据，本实例也没有配置静态访问密钥可供比对。',
      '确认你拿的是不是 CDS 的凭据；如果是别的系统的密钥，那 401 就是应该的。',
    );
  }
  const staticHit = facts.staticKeyHashes.some((h) => hashesEqual(h, presentedHash));
  return staticHit
    ? base(
        'static',
        'active',
        '有效的静态访问密钥。',
        '凭据本身没问题。被拒往往不是权限，而是路由本身要求项目身份 —— 静态密钥没有项目归属。',
      )
    : base(
        'unrecognized',
        'never-issued',
        '这串东西既不匹配任何已签发的凭据，也不是本实例配置的静态访问密钥。',
        '确认连的是不是同一个 CDS 实例、凭据有没有复制完整。',
      );
}
