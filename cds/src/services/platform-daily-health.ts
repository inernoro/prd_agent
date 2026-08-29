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
  /**
   * 它属于哪个项目。**必须带**：infra id 只在项目内唯一，这台机器上六个项目可以各有一个
   * 叫 `redis` 的服务。豁免台账已经按项目记，但结论的 id 与话术如果
   * 还只用 svc.id，两个项目的问题会生成一模一样的 finding id——去重一合并就少一条，
   * 运维也看不出该去修哪个项目的那台（Codex review P2）。
   */
  projectId?: string | null;
  /** 端口是不是发布到了公网（由暴露面自检算出来）。 */
  publiclyPublished: boolean;
  /**
   * 宿主防火墙当前是不是把这个端口挡在外面（同样来自暴露面自检）。
   *
   * **它不是「安全了」的同义词**，所以不能拿来把 publiclyPublished 抹掉：iptables
   * 规则重启就丢，丢了立刻回到裸奔。但它确实改变了「现在有没有人能连上」这件事，
   * 因此判据必须分开两问——「端口绑在哪」与「此刻外面打不打得进来」。
   */
  firewallBlocked?: boolean;
  /** 有没有认证。null = 认不出来（也是一种要报的状态）。 */
  authenticated: boolean | null;
}

/**
 * 一条存量豁免：某台服务眼下靠豁免才起得来，到期后会直接起不来。
 *
 * **单独一份输入，不挂在 HealthInfraFact 上。** 第一版挂在上面，于是倒计时的覆盖面
 * 被运行态事实的覆盖面卡住了——运行态那份是**按暴露面筛过的**（不发布端口的、停着的
 * 都不在里面），而豁免是配置层的事实，跟「此刻有没有对外端口」毫无关系。结果是：
 * 一台纯内网、或者当前停着的老库，豁免到期前不会有任何提示，到期后直接起不来
 * ——而这条倒计时存在的全部意义就是提前说这句话（Codex review P1）。
 *
 * 这是形状 1：判据的取材范围比它该管的范围窄。修法不是把筛子放宽，而是让两件事
 * 各取各的源——运行态取运行态，配置取台账。
 */
export interface InfraExemptionFact {
  id: string;
  projectId?: string | null;
  /** 豁免到期时间（ISO 字符串）。 */
  expiresAt: string;
}

/** 一个备份目标的身份。**必须带项目**：infra id 只在项目内唯一。 */
export interface BackupTargetRef {
  id: string;
  projectId?: string | null;
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
  /**
   * 运行态的数据服务。**包含只在内网可达的那些**——判据里有一整档「内网但无口令」，
   * 只喂「有对外端口的」进来，那一档就永远不会响（Codex review P1）。
   */
  infra: readonly HealthInfraFact[];
  /** 存量豁免台账。取自配置层，覆盖面不受运行态筛选影响。 */
  infraExemptions: readonly InfraExemptionFact[];
  platformStores: readonly HealthPlatformStoreFact[];
  backup: {
    /**
     * 上一轮周期备份**跑完**的时间；null = 真的读不到结果（不等于没问题）。
     *
     * 只回答「跑没跑、多久前跑的」。这一轮备没备全**不许**影响它——那是
     * coverageGaps 与 failedTargets 的职责。混在一起的后果见落盘处的长注释：
     * 一个长期部分失败的部署会天天报「读不到」，而备份其实每 6 小时就在跑。
     */
    lastCompletedAt: string | null;
    /** 上一轮没被覆盖到的目标（按服务类型压根备不了的那批）。 */
    coverageGaps: readonly string[];
    /**
     * 上一轮**本地就没导出来**的目标。与 coverageGaps 不同：这些本该能备，只是没成；
     * 手上**没有**它们的新副本。
     *
     * 带 projectId：infra id 只在项目内唯一，真机一轮里有六个叫 `redis` 的目标，
     * 裸 id 的告警谁也路由不到（Codex review P2）。格式化统一走 `svcRef`。
     */
    failedTargets?: readonly BackupTargetRef[];
    /**
     * 上一轮**本地备成了、只是离机没上去**的目标。
     *
     * 必须与 failedTargets 分开：这批手上有一份验过的同机副本，该修的是离机通道。
     * 混进「没有新副本」里，会把运维支去找一份其实存在的备份（Codex review P2）。
     */
    offsiteOnlyTargets?: readonly BackupTargetRef[];
  };
  /** 最近一次「把备份真的灌回去读通了」的时间；null = 从来没演练过。 */
  lastRestoreDrillAt: string | null;
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
 *
 * **但状态库不是唯一的用户**：`CDS_AUTH_BACKEND=mongo` 是一条独立开关，它自己就要求
 * `CDS_MONGO_URI`，而且 `CDS_STORAGE_MODE=json` 与它是**受支持的组合**。第一版只看
 * 存储模式，于是那种部署里一个正在存账号口令的 Mongo 从体检里彻底消失——比误报更糟，
 * 误报至少还看得见（Codex review P2 第四轮）。所以两个消费方分开问，任一在用就要报。
 */
export function platformStoreFacts(env: Record<string, string | undefined>): HealthPlatformStoreFact[] {
  const explicit = String(env.CDS_STORAGE_MODE || '').trim().toLowerCase();
  const uri = String(env.CDS_MONGO_URI || '').trim();
  const stateUsesMongo = explicit === 'json'
    ? false
    : (explicit === 'mongo' || explicit === 'mongo-split')
      ? true
      : Boolean(uri);
  // 鉴权库：显式写了 mongo 才算。缺省是 memory，index.ts 里认不出的值也退回 memory，
  // 所以这里同样只认这一个字面量——两边不许有第二种口径（形状 3）。
  const authUsesMongo = String(env.CDS_AUTH_BACKEND || '').trim().toLowerCase() === 'mongo';
  if (!stateUsesMongo && !authUsesMongo) return [];
  // 标签说清是谁在用它。两者常常指同一个 Mongo（标准安装就是），
  // 报一条即可，但话要对得上实际配置，否则排障时会找错地方。
  const label = stateUsesMongo && authUsesMongo
    ? 'CDS 状态库与鉴权库'
    : stateUsesMongo ? 'CDS 状态库' : 'CDS 鉴权库';
  return [{ label, connectionUri: uri || null }];
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
 * 此刻真的能从公网连上吗。
 *
 * 「端口绑在全网卡」不等于「外面打得进来」——宿主防火墙挡着的时候，说
 * 「任何人扫到就能直接读写」是一句能被当场验伪的话。判据要取**有效可达性**，
 * 不是取原始绑定（形状 6：读到的值不是真正生效的那个）。
 *
 * 写成函数是为了让三处过滤用同一个口径，不给它们各自漂移的机会（形状 3）。
 */
function reachableFromInternet(s: HealthInfraFact): boolean {
  return s.publiclyPublished && s.firewallBlocked !== true;
}

/**
 * 结论里怎么称呼这台服务。**带项目**：infra id 只在项目内唯一，两个项目各有一个 `redis` 时，
 * 只用 id 会生成两条一模一样的 finding id——按 id 去重就少一条，运维也看不出该修哪个项目的
 * 那一台（Codex review P2）。项目未知时退回裸 id，不编一个假的作用域。
 *
 * 写成函数是为了让 id 与话术用同一个口径，不给它们各自漂移的机会（形状 3）。
 */
function svcRef(s: { id: string; projectId?: string | null }): { key: string; label: string } {
  const p = String(s.projectId || '').trim();
  return p
    ? { key: `${p}::${s.id}`, label: `${p} 项目的 ${s.id}` }
    : { key: s.id, label: s.id };
}

/**
 * 备份与恢复演练这几条结论。
 *
 * **单独抽出来，是因为它有第二个消费者**：项目设置里的「周期备份」面板要在页脚
 * 直接摆出这几句话。把它们留在 evaluateDailyHealth 里、面板那边照着再写一遍，
 * 就是同一个判据分裂成两份、然后各自漂移（形状 3）——这套体检自己已经在
 * 「跑没跑 vs 备没备全」上栽过一次，不再重复。
 *
 * 每日体检调它，面板也调它，措辞与严重级只有这一处定义。
 */
export function backupHealthFindings(input: {
  now: Date;
  backup: DailyHealthInput['backup'];
  lastRestoreDrillAt: string | null;
}): HealthFinding[] {
  const findings: HealthFinding[] = [];
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
  // 「本该能备、但一直没备成」必须自己有一条判据。
  //
  // 拆开「跑没跑」和「备全没备全」之前，这件事是被那条**假**的
  // 「读不到上一轮结果」顺带遮着的——只要有目标失败，完成时间就被抹空，体检就报
  // critical。现在时间戳不再被绑架，如果不在这里补一条，长期失败的目标会从
  // 「假警报」直接变成**沉默**：那是把一个坏判据换成一个更坏的洞。
  //
  // 两类分开报，因为**需要的动作完全不同**：本地就没导出来的，手上一份新副本都没有；
  // 只是离机没上去的，同机那份已经过校验、就在盘上，该修的是离机通道。
  // 合成一句「没有它们的新副本」，会把运维支去找一份其实存在的备份（Codex review P2）。
  const failedTargets = input.backup.failedTargets ?? [];
  if (failedTargets.length > 0) {
    findings.push({
      id: 'backup.failed-targets',
      severity: 'critical',
      message: `上一轮周期备份有 ${failedTargets.length} 个目标本地就没导出来：`
        + `${failedTargets.map((t) => svcRef(t).label).join('、')}`
        + '——手上没有它们的新副本',
    });
  }
  const offsiteOnly = input.backup.offsiteOnlyTargets ?? [];
  if (offsiteOnly.length > 0) {
    findings.push({
      id: 'backup.offsite-only-failed',
      // 比上一条轻一档：同机副本在，丢的是异地冗余，不是全部退路。
      severity: 'warn',
      message: `上一轮有 ${offsiteOnly.length} 个目标只备到了本机、离机副本没上去：`
        + `${offsiteOnly.map((t) => svcRef(t).label).join('、')}`
        + '——本机那份已验证可用，要修的是离机通道',
    });
  }
  if (input.backup.coverageGaps.length > 0) {
    findings.push({
      id: 'backup.coverage-gaps',
      severity: 'warn',
      // 措辞要容得下这一栏的**两种**来源，否则同一份报文会自相矛盾：
      // 一种是按服务类型压根备不了（minio / kafka），另一种是**备成功了、但导出脚本
      // 自报只覆盖到一部分**（rabbitmq 只有定义没有消息、nacos 只有配置没有注册表）。
      // 后者说成「没有被周期备份覆盖」，读者去查备份历史会看到它明明每轮都在备，
      // 于是整份报文的可信度一起掉——这正是这条体检要避免的事。
      // 两者需要的动作确实不同，真要分开报得让缺口带上类型，那是另一件事（台账 E83）。
      message: `${input.backup.coverageGaps.length} 个正在跑的服务备份不完整（没备到，或只备到一部分）：`
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

  return findings;
}

/**
 * 跑一次体检。纯函数：给什么事实就得什么结论，同样的输入永远同样的输出。
 */
export function evaluateDailyHealth(input: DailyHealthInput): DailyHealthVerdict {
  const findings: HealthFinding[] = [];

  // ---- 1. 公网上的无认证数据库：这一类永远排最前 ----
  const nakedOnInternet = input.infra.filter((s) => reachableFromInternet(s) && s.authenticated === false);
  for (const svc of nakedOnInternet) {
    findings.push({
      id: `infra.naked-public.${svcRef(svc).key}`,
      severity: 'critical',
      message: `${svcRef(svc).label} 的端口开在公网上，而且没有认证——任何人扫到就能直接读写`,
    });
  }

  // 认不出有没有认证的，单独报。「不知道」和「没问题」不是一回事。
  for (const svc of input.infra.filter((s) => reachableFromInternet(s) && s.authenticated === null)) {
    findings.push({
      id: `infra.unknown-auth.${svcRef(svc).key}`,
      severity: 'warn',
      message: `${svcRef(svc).label} 的端口开在公网上，但认不出它有没有认证，需要人工确认`,
    });
  }

  // ---- 1b. 绑在全网卡、但眼下被宿主防火墙挡着的 ----
  //
  // 这一类不能报 critical：说「任何人扫到就能直接读写」是**假的**，此刻外面根本
  // 连不上，而一条被验伪的告警会让人开始怀疑整张表。也不能不报：防火墙规则重启
  // 就丢，丢了立刻变成上面那一类。所以单列一档 warn，把「靠什么挡着、为什么不算
  // 解决」写在话里（Codex review P2）。
  //
  // 只在认证有问题时报：认证配好了的库，防火墙这层易失保护由暴露面自检自己报，
  // 体检这边再报一遍只是把同一件事说两次。
  for (const svc of input.infra.filter(
    (s) => s.publiclyPublished && s.firewallBlocked === true && s.authenticated !== true,
  )) {
    findings.push({
      id: `infra.firewall-shielded.${svcRef(svc).key}`,
      severity: 'warn',
      message: `${svcRef(svc).label} 的端口绑在全网卡上`
        + `${svc.authenticated === false ? '且没有认证' : '，且认不出有没有认证'}`
        + '，目前靠宿主防火墙挡着——这层保护重启就丢，丢了立刻变成公网裸奔，'
        + '根治要重建容器把绑定地址收窄',
    });
  }

  // ---- 2. 内网但无口令：公网收口之后，这些就是下一道防线 ----
  for (const svc of input.infra.filter((s) => !s.publiclyPublished && s.authenticated === false)) {
    findings.push({
      id: `infra.naked-internal.${svcRef(svc).key}`,
      severity: 'warn',
      message: `${svcRef(svc).label} 没有认证（目前只在内网可达）`,
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
  const exempt = input.infraExemptions;
  if (exempt.length > 0) {
    // 取最近的那个到期日：先到的先炸。
    const soonest = exempt
      .map((s) => ({ id: svcRef(s).label, days: daysBetween(input.now, s.expiresAt) }))
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

  findings.push(...backupHealthFindings(input));

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
