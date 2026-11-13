/** 只识别原执行器实际发出的带存活保护的 stop/rm，不接受其它复合 shell。 */
export function isOwnedRuntimeCleanup(command: string, ownedIds: ReadonlySet<string>): boolean {
  for (const required of ownedIds) {
    if (!/^[a-f0-9]{64}$/.test(required)) continue;
    for (const target of ownedIds) {
      if (target === required || !/^[a-f0-9]{64}$/.test(target)) continue;
      for (const step of ['stop', 'rm']) {
        const expected = `if [ "$(docker inspect --format '{{.Id}} {{.State.Running}}' '${required}' 2>/dev/null)" != '${required} true' ]; then printf '%s\\n' 'CDS_OLD_RUNTIME_UNAVAILABLE' >&2; exit 125; fi; docker ${step} ${target}`;
        if (command === expected) return true;
      }
    }
  }
  return false;
}
