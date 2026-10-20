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

interface OwnedDirectoryRemoval {
  assertActive(): void;
  /** false仅表示已确认终态的普通删除失败；未知停止/取消必须reject。 */
  remove(directory: string): Promise<boolean>;
}

// 仅此一份换代/回退次序。三个递归删除位置交由同步或同票驱动执行。
function* replacementSteps(pairs: AtomicDirectoryReplacement[]): Generator<string, void> {
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
          yield pair.currentPath;
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
          yield pair.previousBackupPath;
        }
      } else if (pair.hadCurrent) {
        yield pair.backupPath;
      }
    } catch {
      /* stale backup is safe to clean on the next maintenance pass */
    }
  }
}

async function driveOwnedRemoval(steps: Generator<string, void>, removal: OwnedDirectoryRemoval): Promise<void> {
  removal.assertActive();
  let step = steps.next();
  while (!step.done) {
    // reject不能送回算法内原有best-effort catch，否则未知写者仍可能触发后续rename/删除。
    const removed = await removal.remove(step.value);
    removal.assertActive();
    step = removed ? steps.next() : steps.throw(new Error('原子换代的归属删除已失败'));
  }
}

export function replaceDirectoriesAtomically(pairs: AtomicDirectoryReplacement[]): void;
export function replaceDirectoriesAtomically(pairs: AtomicDirectoryReplacement[], removal: OwnedDirectoryRemoval): Promise<void>;
export function replaceDirectoriesAtomically(
  pairs: AtomicDirectoryReplacement[], removal?: OwnedDirectoryRemoval,
): void | Promise<void> {
  const steps = replacementSteps(pairs);
  if (removal) return driveOwnedRemoval(steps, removal);
  let step = steps.next();
  while (!step.done) {
    try {
      fs.rmSync(step.value, { recursive: true, force: true });
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next();
  }
}
