/**
 * Active-color file store — 蓝绿身份持久化(B'.2)
 *
 * `.cds/active-color` 是单实例事实文件:supervisor 切换 daemon 时 atomic write
 * blue|green;daemon 启动时读这个文件决定自己是否 active。
 *
 * 文件语义(取自 doc/design.cds-control-data-split.md §6.2):
 *   - 内容:`blue` 或 `green` 纯文本,无换行约束(读取时 trim)
 *   - 文件不存在 / 内容为空 / 内容非 blue|green → "未初始化"
 *     在未初始化场景下,daemon 默认走 active 模式 —— 因为单进程旧路径
 *     永远应该启动起来响应业务请求,蓝绿才是 opt-in 升级
 *   - daemon promote 时原子写入(tmp + rename)
 *
 * 写入路径不直接调 fs,而是先写 `.cds/active-color.tmp` 再 rename,
 * 避免 reload-watch 的 daemon 读到半截字节。
 */

import fs from 'node:fs';
import path from 'node:path';

export type ActiveColor = 'blue' | 'green';

/** 解析结果。`color === null` 表示文件不存在 / 内容无效 / 未初始化。 */
export interface ActiveColorReadResult {
  color: ActiveColor | null;
  /** 当读取/解析失败时,带上原因字符串方便日志。null 表示成功或文件不存在(也算成功)。 */
  error: string | null;
}

/** 把任意字符串规范化成 ActiveColor,无效值返 null。 */
export function parseActiveColor(raw: string | null | undefined): ActiveColor | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'blue' || trimmed === 'green') return trimmed;
  return null;
}

/**
 * 读取 .cds/active-color。文件不存在或内容不合法时 color=null。
 * 任何 IO 异常(权限/磁盘错误)在 error 字段里抛出,daemon 启动时应当 fail-fast(C-5.5)。
 */
export function readActiveColor(repoRoot: string): ActiveColorReadResult {
  const filePath = path.join(repoRoot, '.cds', 'active-color');
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) {
      return { color: null, error: null };
    }
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { color: null, error: `read active-color failed: ${(err as Error).message}` };
  }
  const color = parseActiveColor(raw);
  return { color, error: null };
}

/**
 * 原子写入 .cds/active-color。先写 .cds/active-color.tmp,再 rename。
 * 调用方负责调用前确保 .cds 目录存在(initStateService 已建好);本函数兜底 mkdir。
 */
export function writeActiveColor(repoRoot: string, color: ActiveColor): void {
  const dir = path.join(repoRoot, '.cds');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, 'active-color');
  const tmpPath = path.join(dir, 'active-color.tmp');
  fs.writeFileSync(tmpPath, color, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * 决定 daemon 启动初始模式(C-1.5 优先级):
 *   1. CDS_DISABLE_BLUE_GREEN=1 → 永远 active(蓝绿短路,简化回退)
 *   2. CLI flag --standby → 强制 standby
 *   3. .cds/active-color 存在且 != selfColor → standby
 *   4. 其它(未初始化 / 颜色相符) → active
 *
 * selfColor 是当前 daemon 自报的颜色(supervisor spawn 时通过 --color blue|green 传入,
 * 缺省时 daemon 没有特定身份,只有"是否 active");selfColor=null 时永远 active(单进程
 * 旧路径)。
 */
export interface InitialModeInputs {
  disableBlueGreen: boolean;
  standbyFlag: boolean;
  selfColor: ActiveColor | null;
  activeColorFile: ActiveColor | null;
}

export function decideInitialActive(inputs: InitialModeInputs): boolean {
  if (inputs.disableBlueGreen) return true;
  if (inputs.standbyFlag) return false;
  if (inputs.selfColor === null) return true; // 没自报颜色 → 单进程旧路径,默认 active
  if (inputs.activeColorFile === null) return true; // 文件未初始化 → 默认 active
  return inputs.selfColor === inputs.activeColorFile;
}
