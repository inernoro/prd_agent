import fs from 'node:fs';

export interface AtomicDirectoryReplacement {
  currentPath: string;
  nextPath: string;
  /**
   * 指定后保留 currentPath 的上一代。适用于内容哈希静态资源：
   * 新 index.html 上线后，已打开的旧页面仍可以请求上一代懒加载模块。
   */
  previousPath?: string;
}

export function replaceDirectoriesAtomically(pairs: AtomicDirectoryReplacement[]): void {
  const stamp = Date.now();
  const backups = pairs.map((pair, idx) => ({
    ...pair,
    backupPath: `${pair.currentPath}.old.${stamp}.${idx}`,
    previousBackupPath: pair.previousPath
      ? `${pair.previousPath}.old.${stamp}.${idx}`
      : undefined,
    hadCurrent: fs.existsSync(pair.currentPath),
    hadPrevious: Boolean(pair.previousPath && fs.existsSync(pair.previousPath)),
    currentMoved: false,
    nextMoved: false,
  }));
  try {
    for (const pair of backups) {
      if (!fs.existsSync(pair.nextPath)) {
        throw new Error(`atomic replacement candidate missing: ${pair.nextPath}`);
      }
    }
    for (const pair of backups) {
      if (pair.previousPath) {
        if (pair.hadPrevious && pair.previousBackupPath) {
          fs.renameSync(pair.previousPath, pair.previousBackupPath);
        }
        if (pair.hadCurrent) {
          fs.renameSync(pair.currentPath, pair.previousPath);
          pair.currentMoved = true;
        }
      } else if (pair.hadCurrent) {
        fs.renameSync(pair.currentPath, pair.backupPath);
        pair.currentMoved = true;
      }
    }
    for (const pair of backups) {
      fs.renameSync(pair.nextPath, pair.currentPath);
      pair.nextMoved = true;
    }
  } catch (err) {
    for (const pair of [...backups].reverse()) {
      try {
        if (pair.nextMoved && fs.existsSync(pair.currentPath)) {
          fs.rmSync(pair.currentPath, { recursive: true, force: true });
        }
        if (pair.previousPath) {
          if (pair.currentMoved && fs.existsSync(pair.previousPath)) {
            fs.renameSync(pair.previousPath, pair.currentPath);
          }
          if (pair.hadPrevious && pair.previousBackupPath && fs.existsSync(pair.previousBackupPath)) {
            fs.renameSync(pair.previousBackupPath, pair.previousPath);
          }
        } else if (pair.currentMoved && fs.existsSync(pair.backupPath)) {
          fs.renameSync(pair.backupPath, pair.currentPath);
        }
      } catch {
        /* best-effort rollback */
      }
    }
    throw err;
  }
  // 新产物已全部就位后才清理临时备份。清理失败不能反向触发回滚：
  // rmSync 可能已部分删除备份，此时回滚反而会丢失已上线的完整产物。
  for (const pair of backups) {
    try {
      if (pair.previousPath) {
        if (pair.hadPrevious && pair.previousBackupPath) {
          fs.rmSync(pair.previousBackupPath, { recursive: true, force: true });
        }
      } else if (pair.hadCurrent) {
        fs.rmSync(pair.backupPath, { recursive: true, force: true });
      }
    } catch {
      /* stale backup is safe to clean on the next maintenance pass */
    }
  }
}
