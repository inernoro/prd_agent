/** New containers must not inherit an unbounded or incompatible daemon logger. */
export const DOCKER_LOG_LIMIT_ARGS = ['--log-driver', 'json-file', '--log-opt', 'max-size=50m', '--log-opt', 'max-file=3'] as const;
export const DOCKER_LOG_LIMIT_FLAGS = ['--log-driver json-file', '--log-opt max-size=50m', '--log-opt max-file=3'] as const;

/** Docker uses decimal units. Rotation can overshoot a file by one log record. */
export function hasBoundedDockerLogs(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const c = config as { Type?: unknown; Config?: Record<string, unknown> };
  if (c.Type !== 'json-file' || !c.Config) return false;
  const size = c.Config['max-size'], files = c.Config['max-file'];
  if (typeof size !== 'string' || typeof files !== 'string' || !/^[1-3]$/.test(files)) return false;
  const match = /^([1-9][0-9]{0,7})([km]?)$/i.exec(size);
  if (!match) return false;
  const bytes = Number(match[1]) * ({'':1,k:1000,m:1000000}[match[2].toLowerCase()] ?? 1);
  return bytes <= 50_000_000;
}
