/**
 * 每日安全体检的判定层：「今天这台机器健康吗」，一句话结论 + 逐条依据。
 *
 * ## 为什么要有
 *
 * 2026-08-23 一次人工安全审计查出来的东西，本来每一项都该由系统自己每天说出来：
 * 旧库端口还开在公网、正式环境的新库和多个 Redis 仍然无口令、正式库三十一天
 * 没有周期备份、离机备份从没做过恢复读回。这些事实**分散在各处**：暴露面自检知道
 * 端口、备份轮次知道新鲜度、认证门禁知道口令——但没有任何一处把它们合起来回答
 * 「今天有没有问题」。于是要等人想起来查一次才发现。
 *
 * 债务台账 G2 早就写着这一条（「自查要覆盖的不止端口……都该有一个『今天这台机器
 * 健康吗』的统一结论」），一直是「部分补上」。本模块把它补齐。
 *
 * ## 两个刻意的设计
 *
 * 1. **平台自身的存储也要查**。认证门禁只挂在「启动项目基础设施容器」那一步，
 *    而 CDS 自己的 Mongo（状态库）不是项目基础设施——它**从来不在门禁的管辖范围内**，
 *    也就永远不会有人被提醒。审计查出的「CDS 主 Mongo / 状态 Mongo 仍接受无密码连接」
 *    正是这个盲区，不是漏做。所以这里单独查一遍连接串里带没带凭据。
 *
 * 2. **「从没做过」必须报出来，不能算通过**。恢复演练没有任何记录时，判据不是
 *    「没有异常」而是「从来没演练过」——no-rootless-tree：证明不了就不能当成成立。
 *    备份新鲜度同理：读不到上一轮结果，报的是「不知道」而不是「没问题」。
 *
 * 本模块只做判定，不碰 docker、不碰文件系统、不发通知，这样能拿真实数值写回归。
 */

/** 一条体检结论的严重程度。ok 之外的都会进摘要。 */
export type HealthSeverity = 'ok' | 'warn' | 'critical';

export interface HealthFinding {
  /** 稳定标识，给去重和告警用。 */
  id: string;
  severity: HealthSeverity;
  /** 一句话说清「什么东西、怎么了」，不需要再去别处查。 */
  message: string;
}

export interface DailyHealthVerdict {
  severity: HealthSeverity;
  /** 第一屏那句话：先给结论，再给数字。 */
  headline: string;
  findings: HealthFinding[];
}

/** 一台被检查的数据服务。 */
export interface HealthInfraFact {
  id: string;
  /** 端口是不是发布到了公网（由暴露面自检算出来）。 */
  publiclyPublished: boolean;
  /** 有没有认证。null = 认不出来（也是一种要报的状态）。 */
  authenticated: boolean | null;
  /** 存量豁免的到期时间；靠豁免才起得来的服务才有。 */
  authExemptionExpiresAt?: string | null;
}

/** 平台自身的存储（不是项目基础设施，门禁管不到）。 */
export interface HealthPlatformStoreFact {
  /** 展示名，如「CDS 状态库」。 */
  label: string;
  /** 连接串。**只用来判断带没带凭据，绝不出现在结论里。** */
  connectionUri: string | null;
}

export interface DailyHealthInput {
  now: Date;
  infra: readonly HealthInfraFact[];
  platformStores: readonly HealthPlatformStoreFact[];
  backup: {
    /** 上一轮周期备份完成时间；null = 读不到（不等于没问题）。 */
    lastCompletedAt: string | null;
    /** 上一轮没被覆盖到的目标。 */
    coverageGaps: readonly string[];
  };
  /** 最近一次「把备份真的灌回去读通了」的时间；null = 从来没演练过。 */
  lastRestoreDrillAt: string | null;
}

/**
 * 豁免台账的 key。**必须带项目**：infra id 只在项目内唯一，六个项目可以各有一个
 * 叫 `redis` 的服务；只用 id 会让 A 项目的豁免被 B 项目同名服务捡走，于是一台
 * 配好认证的库被报成「靠存量豁免在跑」，倒计时也算错（Codex review P2）。
 *
 * 写成函数而不是就地拼串，是为了让**写入与读取用不了两种口径**（形状 3）。
 */
export function exemptKey(projectId: string | undefined | null, id: string): string {
  return `${String(projectId || '')}::${String(id || '')}`;
}

/**
 * 平台自身存储的事实清单。
 *
 * **只在真的用 Mongo 时才给**：CDS 支持 json 状态后端，那种部署压根没有 Mongo，
 * 无条件塞一条 `connectionUri: null` 会被判成「没有凭据」，于是天天为一个不存在的
 * 库报警。一盏永远亮着的灯没人会看——那正是这个体检要治的病，不能自己先犯
 * （Codex review P2）。
 *
 * 判据与 index.ts 里选存储后端那段同源：显式 `CDS_STORAGE_MODE` 优先，
 * 缺省时看有没有连接串。
 */
export function platformStoreFacts(env: Record<string, string | undefined>): HealthPlatformStoreFact[] {
  const explicit = String(env.CDS_STORAGE_MODE || '').trim().toLowerCase();
  const uri = String(env.CDS_MONGO_URI || '').trim();
  const usesMongo = explicit === 'json'
    ? false
    : (explicit === 'mongo' || explicit === 'mongo-split')
      ? true
      : Boolean(uri);
  if (!usesMongo) return [];
  return [{ label: 'CDS 状态库', connectionUri: uri || null }];
}

/** 备份超过这个时长没跑就算陈旧。周期是 6 小时，给两轮的余量。 */
export const BACKUP_STALE_AFTER_MS = 13 * 60 * 60_000;

/** 恢复演练超过这个时长没做就算过期。 */
export const RESTORE_DRILL_STALE_AFTER_MS = 30 * 24 * 60 * 60_000;

/** 存量豁免还剩这么多天就升级为 critical——留出真正来得及做迁移的提前量。 */
export const EXEMPTION_URGENT_DAYS = 14;

/**
 * 连接串里带没带凭据。
 *
 * 只看 userinfo（`scheme://user:pass@host`）这一段。**不打印、不返回连接串本身**——
 * 判定层拿到的是密钥，泄漏它比不做这个检查更糟。
 *
 * 解析不了的一律当「没有」：证明不了有凭据，在安全自检里只能算没有
 * （宁可误报也不漏报，与暴露面自检同向）。
 */
export function connectionUriHasCredentials(uri: string | null | undefined): boolean {
  const value = String(uri || '').trim();
  if (!value) return false;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/@?#]*)@/i.exec(value);
  if (!match) return false;
  const userinfo = match[1];
  // `mongodb://@host` 和 `mongodb://user:@host` 都不算——空口令等于没有口令。
  const [user, password] = userinfo.split(':');
  return Boolean(user && user.trim()) && Boolean(password && password.trim());
}

function daysBetween(from: Date, toIso: string): number | null {
  const to = Date.parse(toIso);
  if (!Number.isFinite(to)) return null;
  return Math.ceil((to - from.getTime()) / 86_400_000);
}

function ageMs(now: Date, iso: string | null): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? now.getTime() - at : null;
}

function worst(items: readonly HealthFinding[]): HealthSeverity {
  if (items.some((f) => f.severity === 'critical')) return 'critical';
  if (items.some((f) => f.severity === 'warn')) return 'warn';
  return 'ok';
}

/**
 * 跑一次体检。纯函数：给什么事实就得什么结论，同样的输入永远同样的输出。
 */
export function evaluateDailyHealth(input: DailyHealthInput): DailyHealthVerdict {
  const findings: HealthFinding[] = [];

  // ---- 1. 公网上的无认证数据库：这一类永远排最前 ----
  const nakedOnInternet = input.infra.filter((s) => s.publiclyPublished && s.authenticated === false);
  for (const svc of nakedOnInternet) {
    findings.push({
      id: `infra.naked-public.${svc.id}`,
      severity: 'critical',
      message: `${svc.id} 的端口开在公网上，而且没有认证——任何人扫到就能直接读写`,
    });
  }

  // 认不出有没有认证的，单独报。「不知道」和「没问题」不是一回事。
  for (const svc of input.infra.filter((s) => s.publiclyPublished && s.authenticated === null)) {
    findings.push({
      id: `infra.unknown-auth.${svc.id}`,
      severity: 'warn',
      message: `${svc.id} 的端口开在公网上，但认不出它有没有认证，需要人工确认`,
    });
  }

  // ---- 2. 内网但无口令：公网收口之后，这些就是下一道防线 ----
  for (const svc of input.infra.filter((s) => !s.publiclyPublished && s.authenticated === false)) {
    findings.push({
      id: `infra.naked-internal.${svc.id}`,
      severity: 'warn',
      message: `${svc.id} 没有认证（目前只在内网可达）`,
    });
  }

  // ---- 3. 平台自身的存储：门禁管不到的那一块 ----
  for (const store of input.platformStores) {
    if (connectionUriHasCredentials(store.connectionUri)) continue;
    findings.push({
      id: `platform-store.no-credentials.${store.label}`,
      severity: 'warn',
      message: `${store.label} 的连接串里没有账号口令。`
        + '它不是项目基础设施，认证门禁**管不到它**，不会有任何人被提醒——'
        + '这一条只有本体检会说',
    });
  }

  // ---- 4. 存量豁免倒计时：到期后那些库会直接起不来 ----
  const exempt = input.infra.filter((s) => s.authExemptionExpiresAt);
  if (exempt.length > 0) {
    // 取最近的那个到期日：先到的先炸。
    const soonest = exempt
      .map((s) => ({ id: s.id, days: daysBetween(input.now, s.authExemptionExpiresAt!) }))
      .filter((x): x is { id: string; days: number } => x.days !== null)
      .sort((a, b) => a.days - b.days)[0];
    if (soonest) {
      const expired = soonest.days <= 0;
      findings.push({
        id: 'infra.auth-exemption-deadline',
        severity: expired || soonest.days <= EXEMPTION_URGENT_DAYS ? 'critical' : 'warn',
        message: expired
          ? `${exempt.length} 个数据库靠存量豁免在跑，而豁免已经到期——它们下次重启会直接起不来`
          : `${exempt.length} 个数据库靠存量豁免在跑，最近的一个还有 ${soonest.days} 天到期`
            + `（${soonest.id}）。到期后它们会直接起不来，不是告警`,
      });
    }
  }

  // ---- 5. 备份新鲜度 ----
  const backupAge = ageMs(input.now, input.backup.lastCompletedAt);
  if (backupAge === null) {
    findings.push({
      id: 'backup.unknown',
      severity: 'critical',
      // 「读不到」不能当成「没问题」：一份从没跑成过的备份和一份跑得好好的备份，
      // 在「没有结果文件」这件事上长得一模一样。
      message: '读不到上一轮周期备份的结果——不确定备份到底有没有在跑，按没有处理',
    });
  } else if (backupAge > BACKUP_STALE_AFTER_MS) {
    findings.push({
      id: 'backup.stale',
      severity: 'critical',
      message: `上一轮周期备份是 ${Math.floor(backupAge / 3_600_000)} 小时前，已经陈旧`,
    });
  }
  if (input.backup.coverageGaps.length > 0) {
    findings.push({
      id: 'backup.coverage-gaps',
      severity: 'warn',
      message: `${input.backup.coverageGaps.length} 个正在跑的服务没有被周期备份覆盖：`
        + input.backup.coverageGaps.join('、'),
    });
  }

  // ---- 6. 恢复演练：没演练过的备份不算备份 ----
  const drillAge = ageMs(input.now, input.lastRestoreDrillAt);
  if (drillAge === null) {
    findings.push({
      id: 'restore-drill.never',
      severity: 'critical',
      message: '从来没有做过一次恢复演练——现在手上这些备份能不能真的读回来，谁也不知道',
    });
  } else if (drillAge > RESTORE_DRILL_STALE_AFTER_MS) {
    findings.push({
      id: 'restore-drill.stale',
      severity: 'warn',
      message: `上一次恢复演练是 ${Math.floor(drillAge / 86_400_000)} 天前，该再做一次了`,
    });
  }

  const severity = worst(findings);
  return { severity, headline: buildHeadline(severity, findings), findings };
}

/**
 * 第一屏那句话。
 *
 * 必须是**判断**不是统计：「4 项异常」放到任何一天都成立，等于没说。
 * 挑最要命的那一条说出来，让人三秒内知道该不该现在起来处理
 * （conclusion-before-numbers）。
 */
function buildHeadline(severity: HealthSeverity, findings: readonly HealthFinding[]): string {
  if (severity === 'ok') return '今天没有发现安全或备份问题';
  const criticals = findings.filter((f) => f.severity === 'critical');
  const lead = criticals[0] ?? findings[0];
  const rest = findings.length - 1;
  const suffix = rest > 0 ? `；另有 ${rest} 项待处理` : '';
  return severity === 'critical'
    ? `需要立刻处理：${lead.message}${suffix}`
    : `有 ${findings.length} 项需要关注：${lead.message}${suffix}`;
}
