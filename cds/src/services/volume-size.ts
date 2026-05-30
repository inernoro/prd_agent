// 项目存储面板 — docker named volume 大小解析/格式化纯函数 (2026-05-29)
//
// feature-emerge 第二波 E7「项目存储面板」的可测内核：
//   - parseDockerSystemDfVolumes: 解析 `docker system df -v` 的 volumes 区段，
//     返回 volumeName → sizeBytes 的映射
//   - parseDockerSize: 把 "45.2MB" / "1.5GiB" / "800B" 这类人类可读大小转 bytes
//   - formatBytes: 把 bytes 转人类可读字符串（IEC 1024 进制）
//
// 这些函数全部纯函数、无 IO，单测可直接断言（见 tests/services/volume-size.test.ts）。
// route 层（routes/project-storage.ts）负责拿 shell 跑 docker 命令 + 调这里解析。

/**
 * 把 docker 输出的人类可读大小（"45.2MB" / "1.5GiB" / "800B" / "0B"）解析为 bytes。
 *
 * docker 在不同子命令里 IEC（KiB=1024）和 SI（kB=1000）混用，我们统一按 1024 进制
 * 解析（差距约 2.4%，存储面板展示用不到字节级精确）。无法解析时返回 null，让上层
 * 走「大小未知」降级而不是误报 0。
 */
export function parseDockerSize(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === 'N/A') return null;
  const m = /^([\d.]+)\s*([KMGTP]?i?B|B)?$/i.exec(s);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KIB: 1024, KB: 1024,
    MIB: 1024 ** 2, MB: 1024 ** 2,
    GIB: 1024 ** 3, GB: 1024 ** 3,
    TIB: 1024 ** 4, TB: 1024 ** 4,
    PIB: 1024 ** 5, PB: 1024 ** 5,
  };
  const mult = multipliers[unit];
  if (mult == null) return null;
  return value * mult;
}

/**
 * 把 bytes 转人类可读字符串（IEC 1024 进制：B / KB / MB / GB / TB）。
 * null 输入返回 '未知'，便于 UI 直接显示。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '未知';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  // 个位数保留 2 位小数，否则 1 位；B 不带小数。
  const decimals = i === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

/**
 * 解析 `docker system df -v` 的 "Local Volumes space usage" 区段，返回
 * volumeName → sizeBytes 映射（无法解析的 SIZE 列置 null）。
 *
 * 典型输出（列宽对齐随版本浮动，故我们按空白切分而非固定列位）：
 *
 *   Local Volumes space usage:
 *   VOLUME NAME                       LINKS     SIZE
 *   cds-mongodb-data                  1         45.2MB
 *   cds-redis-data                    0         0B
 *
 * 鲁棒性策略：
 *   - 只解析 "Local Volumes space usage" 之后、下一个 "space usage:" 区段标题之前的行
 *   - 跳过表头行（以 VOLUME NAME 开头）
 *   - 卷名不含空白，SIZE 总是最后一列；按空白切分取 first=name / last=size
 */
export function parseDockerSystemDfVolumes(stdout: string | undefined | null): Map<string, number | null> {
  const result = new Map<string, number | null>();
  if (!stdout) return result;
  const lines = stdout.split('\n');
  let inVolumesSection = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 区段标题。docker 的区段标题有两种写法：
    //   "Images space usage:" / "Containers space usage:" / "Local Volumes space usage:"
    //   "Build cache usage:"（注意这条没有 "space" 一词）
    // 任一区段标题出现都重置 inVolumesSection，避免 Build cache 区段的行被误当卷。
    if (/\busage:\s*$/i.test(trimmed)) {
      inVolumesSection = /local volumes space usage:/i.test(trimmed);
      continue;
    }
    if (!inVolumesSection) continue;

    // 表头行
    if (/^VOLUME\s+NAME\b/i.test(trimmed)) continue;

    // 数据行：按连续空白切分，first=卷名，last=SIZE
    const cols = trimmed.split(/\s+/);
    if (cols.length < 2) continue;
    const name = cols[0];
    const sizeRaw = cols[cols.length - 1];
    result.set(name, parseDockerSize(sizeRaw));
  }
  return result;
}

/** 宿主机磁盘分区信息（df -h 解析），存储面板顶部展示「磁盘还剩多少」。 */
export interface HostDiskInfo {
  filesystem?: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availBytes: number | null;
  usePercent: number | null;
  mountedOn?: string;
}

/**
 * 解析 `df -kP <path>` 输出（POSIX 模式，单位 1024-byte blocks，单行不折行）：
 *
 *   Filesystem     1024-blocks      Used Available Capacity Mounted on
 *   /dev/sda1        102687672  41234567  56123456      43% /
 *
 * 取数据行（第 2 行）。解析失败返回 null。
 */
export function parseDfOutput(stdout: string | undefined | null): HostDiskInfo | null {
  if (!stdout) return null;
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  // 最后一行通常就是数据行（df -kP 保证不折行）
  const dataLine = lines[lines.length - 1];
  const cols = dataLine.split(/\s+/);
  // Filesystem Blocks Used Available Capacity Mounted-on
  if (cols.length < 6) return null;
  const toBytes = (kb: string): number | null => {
    const n = parseInt(kb, 10);
    return Number.isFinite(n) ? n * 1024 : null;
  };
  const pct = parseInt(cols[4].replace('%', ''), 10);
  return {
    filesystem: cols[0],
    totalBytes: toBytes(cols[1]),
    usedBytes: toBytes(cols[2]),
    availBytes: toBytes(cols[3]),
    usePercent: Number.isFinite(pct) ? pct : null,
    mountedOn: cols.slice(5).join(' '),
  };
}
