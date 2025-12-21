export function sleep(ms: number): Promise<void> {
  const t = Number(ms);
  const safe = Number.isFinite(t) && t > 0 ? t : 0;
  return new Promise<void>((resolve) => window.setTimeout(resolve, safe));
}


