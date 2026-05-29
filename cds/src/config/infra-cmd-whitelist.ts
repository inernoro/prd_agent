/**
 * infra 镜像「必须显式 command」白名单(SSOT)。
 *
 * 某些 image 不带子命令会启动后立即 exit 0,在 unless-stopped 下无限重启拖垮
 * host(历史灾难:openvisual 的 minio cmd 缺失导致 288 次重启)。pending-import
 * 审批校验 和 project-infra-resync 预览校验 都要拦这种配置。
 *
 * 2026-05-29 Cursor Bugbot(PR #684):此前该白名单在 pending-import.ts 和
 * project-infra-resync.ts 各抄一份,加新模式(如 Redis Sentinel)要改两处、容易
 * 漏一处导致静默漂移。抽到这里做唯一来源,两边 import。
 */
export interface InfraCmdRequirement {
  pattern: RegExp;
  /** 给用户的修复示例(yaml command 行) */
  example: string;
}

export const INFRA_NEEDS_CMD: InfraCmdRequirement[] = [
  { pattern: /^minio\/minio/i, example: 'command: ["server", "/data", "--console-address", ":9001"]' },
  { pattern: /^(docker\.io\/library\/)?elasticsearch:/i, example: 'command: ["elasticsearch", "-Ediscovery.type=single-node"]' },
];

/** command 是否为空(undefined / 空串 / 空数组)。 */
export function isInfraCommandEmpty(command: string | string[] | undefined): boolean {
  return command === undefined
    || (typeof command === 'string' && !command.trim())
    || (Array.isArray(command) && command.length === 0);
}

/**
 * 找出违反「必须带 command」白名单的 infra 服务(命中模式但 command 为空)。
 * 返回每条违规 + 对应修复示例。空数组 = 全部通过。
 */
export function findInfraCmdViolations(
  infraServices: Array<{ id: string; dockerImage: string; command?: string | string[] }>,
): Array<{ id: string; dockerImage: string; example: string }> {
  const violations: Array<{ id: string; dockerImage: string; example: string }> = [];
  for (const svc of infraServices) {
    const match = INFRA_NEEDS_CMD.find((r) => r.pattern.test(svc.dockerImage));
    if (!match) continue;
    if (isInfraCommandEmpty(svc.command)) {
      violations.push({ id: svc.id, dockerImage: svc.dockerImage, example: match.example });
    }
  }
  return violations;
}
