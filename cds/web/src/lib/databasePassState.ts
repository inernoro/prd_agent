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

/** Browsers may leave clipboard writes pending while the tab is in the background. */
export async function copyDatabasePassCredentials(copy: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      copy(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('clipboard timeout')), 5000);
      }),
    ]);
  } catch {
    throw new Error('未能确认连接信息已复制。请保持当前页在前台，并允许剪贴板访问后重试；也可先撤销通行证。');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
