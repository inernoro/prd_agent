/**
 * release-disk-guard —— 发布目标「磁盘护栏」失败的识别与复述（纯函数）。
 *
 * 背景（2026-07-30）：生产发布四连死在项目发布脚本的磁盘护栏
 * （scripts/llmgw-disk-space-guard.sh 输出
 * `requires at least <N>MB free on <mount>; available=<M>MB`），
 * 而 CDS 的站内信只会复述「ssh exec exit=1」——用户要求「下次可以在 CDS 里警报」。
 *
 * 本模块给两处消费方提供同一份判据：
 *  1. release-events：发布失败事件带上人话磁盘结论，站内信铃直接说「还差多少」；
 *  2. release-service 预检：上次因磁盘失败后，发布前先 df 复查，不够线就拦在
 *     「开始发布」之前，别再烧一次注定失败的 run。
 *
 * 前端 web/src/lib/releaseDiagnosis.ts 有一份同判据的解析（浏览器包不 import 后端源码），
 * tests/services/release-disk-diagnosis.test.ts 用同一组 fixture 钉住两边不许漂移。
 */

export interface DiskGuardShortfall {
  requiredMb: number;
  availableMb: number;
  shortfallMb: number;
  mountPoint: string;
}

const DISK_GUARD_PATTERN = /requires at least (\d+)MB free on (\S+); available=(\d+)MB/;

/** 从发布日志行里认出磁盘护栏失败并算差额；认不出返回 null。 */
export function parseDiskGuardShortfall(messages: ReadonlyArray<string>): DiskGuardShortfall | null {
  for (const message of messages) {
    const match = DISK_GUARD_PATTERN.exec(message);
    if (!match) continue;
    const requiredMb = Number(match[1]);
    const availableMb = Number(match[3]);
    if (!Number.isFinite(requiredMb) || !Number.isFinite(availableMb)) continue;
    return {
      requiredMb,
      availableMb,
      shortfallMb: Math.max(0, requiredMb - availableMb),
      mountPoint: match[2],
    };
  }
  return null;
}

/** 站内信里那句人话：说清差多少、下一步去哪。 */
export function describeDiskShortfall(shortfall: DiskGuardShortfall): string {
  return `目标机磁盘不足：${shortfall.mountPoint} 需 ${shortfall.requiredMb}MB 空闲，`
    + `当前 ${shortfall.availableMb}MB，还差 ${shortfall.shortfallMb}MB。`
    + '到发布中心失败详情里可跑只读磁盘诊断，清理后重试。';
}

/**
 * 解析 `df -Pm <path>` 输出的可用 MB（POSIX 格式第二行第 4 列）。
 * 解析失败返回 null——调用方给「无法确认」的 warn，不许编数。
 */
export function parseDfAvailableMb(output: string): number | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dataLine = lines.find((line) => /^\/\S*\s/.test(line) || /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+\S+/.test(line));
  if (!dataLine) return null;
  const columns = dataLine.split(/\s+/);
  const available = Number(columns[3]);
  return Number.isFinite(available) && available >= 0 ? available : null;
}
