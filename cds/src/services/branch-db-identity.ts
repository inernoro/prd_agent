/**
 * 分支数据库账号身份（抗碰撞）。
 *
 * ## 这个模块解决的事故
 *
 * 2026-09-01，用户报「数据库连接功能报错，部分数据库是可以的」，实际报文是：
 *
 *   GET /api/branches/mdimp-claude-open-api-channel-cl04-byglbh/resources/
 *       infra%3Acloudbridge-db/data/tables 失败：
 *   ERROR 1045 (28000): Access denied for user 'cds_mdimp_claude_open_api_ch'@'localhost'
 *
 * 那个账号名不是巧合：旧派发规则是「`cds_` + 分支 id 的 slug **截断到 24 字符**」，
 * `mdimp-claude-open-api-channel-cl04-byglbh` 截到第 24 个字符就是
 * `mdimp_claude_open_api_ch` —— 后面的 `cl04-byglbh` 全被切掉。于是同一个项目下
 * 所有 `claude/open-api-ch...` 开头的分支**共用同一个 MySQL 账号**，而派发流程
 * （建库 / 重置凭据 / 克隆库）每次都 `ALTER USER ... IDENTIFIED BY <新随机口令>`：
 *
 *   - 最后派发的那个分支拿到当前口令，能连上（「部分数据库是可以的」）；
 *   - 先派发的兄弟分支，env 里存的还是旧口令 → 每次都 1045；
 *   - 更狠的一条：某个兄弟分支删库时会 `DROP USER`，把共用账号整个删掉，
 *     其余分支一起 1045（用户不存在时 MySQL 同样报 Access denied）。
 *
 * 根因是 `predicate-and-wiring-discipline.md` 形状 1：**把「截断后的显示名」当成了
 * 唯一身份**。截断永远不唯一，长前缀命名（本仓库 Agent 分支就是这种）必然撞。
 *
 * ## 现在的规则
 *
 * 账号名 = `cds_` + 可读前缀（截断，只为人眼认得出是哪个分支） + `_` + 分支 id 的
 * **指纹**（sha256 前 8 位十六进制）。可读前缀允许截断、允许撞；**唯一性由指纹保证**。
 * 派发是确定性的：同一个分支 id 永远算出同一个账号名，重复派发不会造出第二个账号。
 *
 * 32 字符是 MySQL 8 的账号名上限（`mysql.user.User` 是 CHAR(32)），postgres(63) /
 * mongo 更宽，统一按最紧的那个来，一个分支在三种库里拿到同一个账号名。
 */
import { createHash } from 'node:crypto';

/** MySQL 8 的账号名上限（CHAR(32)）；三种库统一按最紧的这个算。 */
export const BRANCH_DB_ACCOUNT_MAX_LEN = 32;

const ACCOUNT_PREFIX = 'cds_';
/** 指纹长度：16^8 ≈ 43 亿，单个 MySQL 实例里的分支账号量级下撞名概率可忽略。 */
const FINGERPRINT_LEN = 8;

/** 归一成 SQL 标识符安全的字符集（小写字母 / 数字 / 下划线，不以下划线开头结尾）。 */
function normalizeForSqlIdentifier(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** 分支 id 的指纹。取**完整** id，不截断——截断的东西不能当身份。 */
export function branchDbFingerprint(branchId: string): string {
  return createHash('sha256').update(String(branchId), 'utf8').digest('hex').slice(0, FINGERPRINT_LEN);
}

/**
 * 派发给某分支的数据库账号名。确定性、抗碰撞、≤ maxLen。
 *
 * 可读前缀只是给人看的，长度不够就截断；两个分支的可读前缀可以完全一样，
 * 后缀的指纹保证它们仍是两个账号。
 */
export function branchDbAccountName(branchId: string, maxLen: number = BRANCH_DB_ACCOUNT_MAX_LEN): string {
  const fingerprint = branchDbFingerprint(branchId);
  const minLen = ACCOUNT_PREFIX.length + FINGERPRINT_LEN;
  const budget = Math.max(0, Math.min(maxLen, 64) - minLen - 1);
  const readable = normalizeForSqlIdentifier(branchId).slice(0, budget).replace(/_+$/, '');
  return readable ? `${ACCOUNT_PREFIX}${readable}_${fingerprint}` : `${ACCOUNT_PREFIX}${fingerprint}`;
}

/**
 * 旧的截断派发规则。**只用于诊断**（判断某个存量账号名是不是旧规则算出来的），
 * 不要再拿它派发新账号。
 */
export function legacyBranchDbAccountName(branchId: string): string {
  const slug = String(branchId || '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `${ACCOUNT_PREFIX}${slug.replace(/-/g, '_').slice(0, 24)}`.slice(0, BRANCH_DB_ACCOUNT_MAX_LEN);
}

export type BranchDbRuntime = 'mysql' | 'postgres' | 'mongodb';

/** 派发时写进分支 env 的「这套凭据是给哪台服务的」标记：值就是 InfraService.id。 */
const OWNER_HOST_KEYS: Record<BranchDbRuntime, string[]> = {
  mysql: ['MYSQL_HOST'],
  postgres: ['POSTGRES_HOST'],
  mongodb: ['MONGODB_HOST'],
};

/** HOST 缺失时的兜底：从连接串里把 host 抠出来（派发时 host 段同样写的是服务 id）。 */
const OWNER_URL_KEYS: Record<BranchDbRuntime, string[]> = {
  mysql: ['MYSQL_URL', 'DATABASE_URL'],
  postgres: ['POSTGRES_URL', 'DATABASE_URL'],
  mongodb: ['MONGODB_URL', 'DATABASE_URL'],
};

/**
 * 连接串的 scheme 必须与运行时对得上才认。
 *
 * `DATABASE_URL` 是**共用键**：同一个分支后来注入 PostgreSQL 或 MongoDB 凭据时，它就指向
 * 那台库的 host。拿它当 MySQL 的归属证据，会把仍然有效的 `MYSQL_*` 判成「别人的」，
 * 于是工作台/备份/连接串全都回落到服务默认凭据与默认库——读写的可能是共享数据
 * （Codex P1，2026-09-01）。运行时专属键（MYSQL_URL 等）本身已带语义，共用键必须验 scheme。
 */
const OWNER_URL_SCHEMES: Record<BranchDbRuntime, RegExp> = {
  mysql: /^(mysql|mysqlx|mariadb)$/i,
  postgres: /^(postgres|postgresql)$/i,
  mongodb: /^(mongodb|mongodb\+srv)$/i,
};

/**
 * 这套分支凭据是派发给哪台服务的；判断不出来返回空串。
 *
 * ## 为什么需要这个
 *
 * 分支作用域的 env 是**一张平表**：`MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`
 * 各自只有一份。可是一个分支完全可以挂**两台 MySQL**（2026-09-01 现场就是：
 * `cloudbridge-db` 与 `mysql-mdimp` 并存）。于是后派发的那台把前一台的账号、口令和库名
 * 整个盖掉，工作台再拿这一份去连另一台——账号在那台库里根本不存在，报 1045。
 * 「CDS 自己建的库，CDS 自己连不上」就是这么来的。
 *
 * 派发时写入的 `*_HOST`（值是 InfraService.id）就是天然的归属标记，据此判断即可。
 */
export function branchDbCredentialOwner(branchEnv: Record<string, string>, runtime: BranchDbRuntime): string {
  const env = branchEnv || {};
  // 不认识的运行时（RabbitMQ / MinIO / redis…）没有分支凭据这套东西，直接「判断不出」。
  // 少了这道，调用方传进一个 unknown 会在下面 for...of undefined 上抛，把只读端点打成 500
  // （Codex P1，2026-09-01）。
  if (!OWNER_HOST_KEYS[runtime]) return '';
  for (const key of OWNER_HOST_KEYS[runtime]) {
    const value = String(env[key] ?? '').trim();
    if (value) return value;
  }
  for (const key of OWNER_URL_KEYS[runtime]) {
    const raw = String(env[key] ?? '').trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      const scheme = url.protocol.replace(/:$/, '');
      if (!OWNER_URL_SCHEMES[runtime].test(scheme)) continue;
      const host = url.hostname;
      if (host) return host;
    } catch {
      /* 连接串解析不了就当作判断不出来，继续下一个 */
    }
  }
  return '';
}

/**
 * 分支 env 里那套凭据能不能用在这台服务上。
 *
 * 判断不出归属（老数据没写 HOST、也没有可解析的连接串）时返回 true——维持既有行为，
 * 不因为多了一条判据把原本能用的分支弄成连不上。
 */
export function branchDbCredentialsBelongTo(
  branchEnv: Record<string, string>,
  runtime: BranchDbRuntime,
  serviceId: string,
): boolean {
  const owner = branchDbCredentialOwner(branchEnv, runtime);
  if (!owner) return true;
  return owner === String(serviceId || '').trim();
}

/** 这个账号名是不是 CDS 派发的分支账号（而不是用户自己填在环境变量里的账号）。 */
export function isCdsManagedBranchAccount(user: string): boolean {
  return /^cds_[a-z0-9_]+$/.test(String(user || ''));
}

/**
 * 数据库把连接**认证**挡掉了（口令不对 / 账号不存在），而不是别的错。
 *
 * MySQL 的 1045 对「口令错」和「账号根本不存在」报同一句话，所以这条判据只回答
 * 「是不是认证被拒」，不回答「为什么被拒」——后者由 explainBranchDbAuthFailure 给证据。
 */
export function isDbAuthFailure(message: string): boolean {
  const text = String(message || '');
  // PostgreSQL 的 `FATAL: role "cds_..." does not exist`：角色被删掉了，也是认证这条线的
  // 事（口令不对与账号不在，对用户是同一个下一步）。不认它就只剩一行裸报文，
  // 凭据恢复路径被藏起来（Codex P2，2026-09-01）。
  return /ERROR\s*1045|Access denied for user|password authentication failed|authentication failed|auth failed/i.test(text)
    || /\brole\s+"?[^"\s]+"?\s+does not exist/i.test(text);
}

/**
 * 把裸的 1045 翻译成「为什么 + 下一步」。
 *
 * 只对 CDS 派发的分支账号加解释：用户自己填的账号连不上，多半就是他自己填错了，
 * 硬套一段「点重置凭据」的指引只会误导（`no-rootless-tree.md`：没有根据就别下结论）。
 */
export function explainBranchDbAuthFailure(params: {
  runtime: 'mysql' | 'postgres';
  branchId: string;
  user: string;
  rawError: string;
  /**
   * 这台库的管理员账号（MySQL root）CDS 到底拿不拿得到。
   *
   * 这条不是装饰：重新派发分支账号要以管理员身份执行 `ALTER USER`，而随机 root 口令
   * （`MYSQL_RANDOM_ROOT_PASSWORD`）的容器**谁都没有那个口令**——镜像只往容器日志里
   * 打过一次。对这种库指路「点重置连接凭据」就是把人送进死胡同：他点了，报另一条
   * 1045（这次是 root）。拿不到就得说拿不到，并给真正走得通的路。
   *
   * 不传 = 不知道，按「能重置」给指引（保持既有行为）。
   */
  adminAvailable?: boolean;
}): string {
  const { runtime, branchId, user, rawError, adminAvailable } = params;
  const raw = String(rawError || '').trim();
  if (!isDbAuthFailure(raw) || !isCdsManagedBranchAccount(user)) return raw;
  const label = runtime === 'postgres' ? 'PostgreSQL' : 'MySQL';
  const collided = user === legacyBranchDbAccountName(branchId) && user !== branchDbAccountName(branchId);
  return [
    `${label} 拒绝了分支账号 ${user}：口令对不上，或这个账号已经不在了。`,
    collided
      ? `这个账号名是旧规则按分支名截断算出来的（${user}）——同项目下前缀相同的兄弟分支会算出同一个账号，`
        + '谁最后派发谁改掉口令，别人就连不上；兄弟分支删库时还会把这个共用账号一并删掉。'
        + '派发规则已改成带指纹的唯一账号名，重新派发一次即可摆脱共用。'
      : '分支账号由 CDS 派发，口令只存在 CDS 的分支环境变量里；口令对不上说明它在库里被改过或账号被删过。',
    adminAvailable === false
      ? '下一步：这台库没有 CDS 拿得到的管理员口令（容器用的是随机 root 口令，或压根没配 root 口令），'
        + '「重置连接凭据」需要管理员身份执行，因此这条路走不通。可行的两条：'
        + '一是由有权限的人直连这台库，为该分支账号重设口令、或换用容器自带的应用账号；'
        + '二是给这个服务补上 root 口令并重建容器，之后再回来点「重置连接凭据」。'
      : '下一步：在该资源的面板点「重置连接凭据」重新派发（会输入资源名二次确认）；'
        + '重置后应用容器要重新部署一次才会拿到新口令。',
    raw ? `原始错误：${raw}` : '',
  ].filter(Boolean).join('\n');
}
