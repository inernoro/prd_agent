const DOCKER_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z)(\s+)/;
const APP_BRACKET_TIMESTAMP_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*/;

export function normalizeContainerLogLineForDisplay(line: string): string {
  const dockerTs = line.match(DOCKER_TIMESTAMP_RE);
  if (!dockerTs) return line;

  const rest = line.slice(dockerTs[0].length);
  const appTs = rest.match(APP_BRACKET_TIMESTAMP_RE);
  if (!appTs) return line;

  const [, dockerHour, dockerMinute, dockerSecond] = dockerTs;
  const [, appHour, appMinute, appSecond] = appTs;
  if (dockerHour !== appHour || dockerMinute !== appMinute || dockerSecond !== appSecond) {
    return line;
  }

  return `${dockerTs[1]}${dockerTs[5]}${rest.slice(appTs[0].length)}`;
}

export function normalizeContainerLogsForDisplay(logs: string): string {
  return logs
    .split(/\r?\n/)
    .map((line) => normalizeContainerLogLineForDisplay(line))
    .join('\n');
}
