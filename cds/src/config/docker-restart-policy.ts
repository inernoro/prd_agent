/**
 * Docker restart 策略校验(SSOT)。
 *
 * 2026-05-29 Codex review(PR #684, P1 安全):infra 的 restartPolicy 会被原样拼进
 * 经 shell 执行的 `docker run` 字符串。该值来源有三:yaml 的 `restart:`、
 * POST /api/infra 的 body.restartPolicy、infra resync。若是 `no; touch /tmp/pwn`
 * 之类,shell 会在 host 执行注入后缀 → 命令注入。这里按 Docker 官方允许的 restart
 * 策略白名单校验,非法值回落默认,杜绝注入。
 *
 * Docker 合法值:no / always / unless-stopped / on-failure / on-failure:<max-retries>
 */

export const DEFAULT_DOCKER_RESTART_POLICY = 'on-failure:3';

const DOCKER_RESTART_POLICY_PATTERN = /^(no|always|unless-stopped|on-failure(:\d+)?)$/;

/** 是否是 Docker 合法的 restart 策略字符串。 */
export function isValidDockerRestartPolicy(value: unknown): value is string {
  return typeof value === 'string' && DOCKER_RESTART_POLICY_PATTERN.test(value.trim());
}

/**
 * 把任意输入规整成可安全拼进 docker run 的 restart 策略:
 *  - 合法 → 返回 trim 后的值
 *  - 非法 / 空 / 非字符串 → 返回默认 on-failure:3
 */
export function sanitizeDockerRestartPolicy(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DOCKER_RESTART_POLICY;
  const trimmed = value.trim();
  return DOCKER_RESTART_POLICY_PATTERN.test(trimmed) ? trimmed : DEFAULT_DOCKER_RESTART_POLICY;
}
