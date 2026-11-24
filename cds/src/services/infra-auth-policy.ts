import { detectInfraAuth, detectInfraKind } from './infra-exposure-audit.js';

export interface InfraAuthInput {
  dockerImage: string;
  id?: string;
  name?: string;
  basePresetId?: string;
  containerName?: string;
  containerPort?: number;
  env?: Record<string, string> | null;
  command?: string | string[];
  entrypoint?: string | string[];
}

function hasValue(env: Record<string, string>, ...keys: string[]): boolean {
  return keys.some((key) => Boolean(String(env[key] || '').trim()));
}

function commandText(input: InfraAuthInput): string {
  return [input.command, input.entrypoint]
    .flatMap((value) => Array.isArray(value) ? value : value == null ? [] : [value])
    .map(String)
    .join(' ');
}

/**
 * 新建数据服务的认证硬门禁。
 *
 * 这里检查的是容器真正会使用的 env/command，而不是 CDS 台账里的“预期配置”。
 * 存量容器由运行态暴露审计发现并安排有备份的迁移；本函数只阻止继续创建新的
 * 无认证实例，避免在没有恢复副本时擅自重建现有数据容器。
 */
export function assertInfraAuthenticationConfigured(input: InfraAuthInput): void {
  const kind = detectInfraKind(input.dockerImage, input);
  const env = input.env || {};
  const command = commandText(input);
  let configured = true;

  if (kind === 'mongo') {
    configured = hasValue(env, 'MONGO_INITDB_ROOT_USERNAME', 'MONGO_USERNAME', 'MONGODB_USERNAME')
      && hasValue(env, 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_PASSWORD', 'MONGODB_PASSWORD');
  } else if (kind === 'postgres') {
    configured = hasValue(env, 'POSTGRES_PASSWORD', 'PGPASSWORD');
  } else if (kind === 'mysql') {
    const hasExplicitRootPassword = hasValue(env, 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD');
    // 周期备份固定使用 root 执行全库导出。随机 root 密码不会回写到环境变量，
    // 因而无法被备份任务复用；这里只接受可持续读取的显式 root 凭据。
    if (!hasExplicitRootPassword) {
      throw new Error('拒绝创建缺少可复用备份凭据的 mysql 基础设施；请配置 CDS 生成的显式 root 凭据后重试');
    }
    configured = true;
  } else if (kind === 'redis') {
    // **不在这里另写一份**（2026-08-27 收敛，台账 E81）：原来这里用两条正则自己判，
    // 而运行态自检那份判据取或还认了 env，于是同一台库两处结论相反。redis 与
    // memcached / kafka / nats 一样，只留 `detectInfraAuth` 那一份。
    //
    // 顺带修好一处旧漏：原来的正则只认 `--requirepass` / `--aclfile`，
    // 漏了 ACL 的 `--user`；共用判据把它一并覆盖了。
    configured = detectInfraAuth('redis', env, [
      ...(Array.isArray(input.command) ? input.command : input.command ? [input.command] : []),
      ...(Array.isArray(input.entrypoint) ? input.entrypoint : input.entrypoint ? [input.entrypoint] : []),
    ]) === true;
  } else if (kind === 'sqlserver') {
    configured = hasValue(env, 'MSSQL_SA_PASSWORD', 'SA_PASSWORD');
  } else if (kind === 'clickhouse') {
    configured = hasValue(env, 'CLICKHOUSE_PASSWORD');
  } else if (kind === 'rabbitmq') {
    configured = hasValue(env, 'RABBITMQ_DEFAULT_USER')
      && hasValue(env, 'RABBITMQ_DEFAULT_PASS');
  } else if (kind === 'elasticsearch') {
    const security = String(env['xpack.security.enabled'] || env.XPACK_SECURITY_ENABLED || '')
      .trim()
      .toLowerCase();
    configured = security !== 'false' && hasValue(env, 'ELASTIC_PASSWORD');
  } else if (kind === 'minio') {
    configured = hasValue(env, 'MINIO_ROOT_USER', 'MINIO_ACCESS_KEY')
      && hasValue(env, 'MINIO_ROOT_PASSWORD', 'MINIO_SECRET_KEY');
  } else if (kind === 'memcached' || kind === 'kafka' || kind === 'nats') {
    /**
     * 这三类**不在这里另写一份判据**，直接问运行态自检那一份。
     *
     * 原因是第一版真的分裂过：门禁这边顺手认了「env 里有 MEMCACHED_PASSWORD」，
     * 自检那边只认「命令行上真的启用了 -Y」。于是同一台库，门禁放行、自检报
     * critical——**口令存在不等于服务在校验它**，自检那一版才是对的。
     * 两个判据判同一件事就必然漂移（形状 3），所以只留一份。
     *
     * `detectInfraAuth` 只接 env + 启动参数，把 command 与 entrypoint 一起送进去：
     * 这三个预设的认证恰恰写在「entrypoint 覆盖成 sh 之后再 exec 回去」的那条命令里。
     *
     * 返回 null（认不出类型）在这里不可能发生——kind 已经是这三个之一；
     * 真出现也按「证明不了」处理，与自检同向。
     */
    configured = detectInfraAuth(kind, env, [
      ...(Array.isArray(input.command) ? input.command : input.command ? [input.command] : []),
      ...(Array.isArray(input.entrypoint) ? input.entrypoint : input.entrypoint ? [input.entrypoint] : []),
    ]) === true;
  }

  if (!configured) {
    throw new Error(`拒绝创建无认证的 ${kind} 基础设施；请配置 CDS 生成的凭据后重试`);
  }
}

/**
 * 门禁在生产生效的时刻。早于这个时间被登记的服务算「存量」。
 *
 * 用登记时间而不是「容器在不在」来判存量：后者要现查 docker，把纯判定变成异步，
 * 而且「容器碰巧还在」本身不构成豁免理由——真正的理由是**这批库在门禁出现之前就
 * 已经承载着数据在跑，重建它们需要迁移计划，不是启动时能顺手做的事**。
 */
export const INFRA_AUTH_GATE_LIVE_AT = '2026-08-18T00:00:00.000Z';

/** 存量豁免的默认到期日。到期后存量库同样启动不了——这是欠条，不是赦免。 */
export const INFRA_AUTH_GRACE_DEFAULT_UNTIL = '2026-09-17T00:00:00.000Z';

/** 距到期不足这个天数就升级为 error：留出真正来得及做迁移的提前量。 */
const URGENT_DAYS = 7;

export interface InfraAuthDecision {
  allowed: boolean;
  /** 不允许时的原因。 */
  reason?: string;
  /** 走了存量豁免才放行时的说明；正常配了认证的服务没有这一项。 */
  exemption?: {
    expiresAt: string;
    daysLeft: number;
    urgent: boolean;
    message: string;
  };
}

/**
 * 认证门禁的完整判定：**新建仍然强制，存量限期放行**。
 *
 * ## 为什么要有豁免
 *
 * 2026-08-18 门禁上线后，平台立刻停摆：它装在「启动基础设施」这一步，而分支部署
 * 必然要确保依赖的库在跑。于是五个项目十几个无认证的存量库全部启动不了，
 * 连 prd-agent 主分支预览都部署失败——而那些库本身活得好好的，数据也在。
 *
 * 门禁的方向没错，错在**把「不许再造新的」和「立刻停掉已有的」混成了一件事**。
 * 前者是纪律，后者是停机。
 *
 * ## 豁免的三条边界（缺一条就会变成永久赦免）
 *
 * 1. **只给存量**：登记时间早于门禁上线时刻的服务。之后新建的一律照拦。
 * 2. **会到期**：过了期限，存量同样拦。到期日可以由运维显式推迟，但那是一个
 *    需要动手的决定，不是默默续期。
 * 3. **看得见**：每次靠豁免放行都要留痕，并在临近到期时升级严重程度。
 *    一个没人看见的豁免，和把门禁删掉没有区别。
 */
export function evaluateInfraAuthentication(
  input: InfraAuthInput & { createdAt?: string | null },
  opts: {
    /** 到期日覆盖，给运维显式延期用。 */
    graceUntil?: string | null;
    now?: Date;
  } = {},
): InfraAuthDecision {
  try {
    assertInfraAuthenticationConfigured(input);
    return { allowed: true };
  } catch (err) {
    const reason = (err as Error).message;
    const now = opts.now ?? new Date();
    const until = Date.parse(String(opts.graceUntil || INFRA_AUTH_GRACE_DEFAULT_UNTIL));
    const created = Date.parse(String(input.createdAt || ''));
    const gateLive = Date.parse(INFRA_AUTH_GATE_LIVE_AT);

    // 登记时间读不出来的，按新建处理——不确定就不放行。
    const isLegacy = Number.isFinite(created) && created < gateLive;
    if (!isLegacy) {
      return { allowed: false, reason };
    }
    if (!Number.isFinite(until) || now.getTime() >= until) {
      return {
        allowed: false,
        reason: `${reason}（存量豁免已于 ${new Date(until).toISOString()} 到期）`,
      };
    }
    const daysLeft = Math.max(0, Math.ceil((until - now.getTime()) / 86_400_000));
    const urgent = daysLeft <= URGENT_DAYS;
    return {
      allowed: true,
      exemption: {
        expiresAt: new Date(until).toISOString(),
        daysLeft,
        urgent,
        message: `${input.id || input.containerName || '未命名服务'} 是门禁上线前的存量库，`
          + `按存量豁免放行；还有 ${daysLeft} 天到期（${new Date(until).toISOString()}），`
          + `到期后将无法启动。请在此之前完成认证迁移。`,
      },
    };
  }
}
