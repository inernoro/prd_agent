/** History must not replace an outstanding pass or suppress its action feedback. */
export function databasePassState<T extends { status: string }>(passes: T[]): {
  current: T | undefined;
  latest: T | undefined;
  terminal: boolean;
} {
  const latest = passes.at(-1);
  const current = passes.filter(pass => ['prepared', 'active', 'cleanup-failed', 'preparing'].includes(pass.status)).at(-1);
  return { current, latest, terminal: !current && !!latest && ['expired', 'revoked'].includes(latest.status) };
}
