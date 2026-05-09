/**
 * BuildShaChip 纯逻辑(B'.6)
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md C-6.2 / C-6.3
 *
 * 把"如何根据 self-status payload 决定 chip 显示什么"从 React 组件里抽出来,
 * 这样测试可以在 cds/tests/topology/build-sha-chip.test.ts 里跑(无 jsx,
 * 不依赖浏览器 / jsdom)。
 *
 * 渲染层(BuildShaChip.tsx)只负责把这里产出的 ChipState 套上 Tailwind / DOM。
 */

export type ChipMode =
  | 'normal'      // 正常 active,gitHead == activeDaemonSha,显示 build: <sha> · <color>
  | 'standby'    // 当前实例是 standby,显示 standby · <color>
  | 'switching'  // 双 daemon 都活着的短窗口,显示 切换中
  | 'drift'      // gitHead != activeDaemonSha,变红 + 闪烁
  | 'offline';   // self-status 失败 / 无数据,显示 离线

export type ChipColor = 'blue' | 'green' | null;

export interface ChipState {
  mode: ChipMode;
  /** 主标签 — 例 "build: d931074 · blue"。 */
  label: string;
  /** 颜色徽章(影响背景色)。standby/offline/drift 不参与色彩 logic。 */
  color: ChipColor;
  /** 鼠标悬浮 tooltip 文本(多行用 \n 分隔)。 */
  tooltip: string;
  /** 是否变红(drift / offline)。 */
  isError: boolean;
  /** 是否需要触发 1 次闪烁(drift mode 进入时)。 */
  shouldBlink: boolean;
  /** 点击 chip 跳转目标。 */
  navigateTo: string;
  /** 是否进一步 highlight 维护页 self-update 按钮(drift 才需要)。 */
  highlightSelfUpdate: boolean;
}

/**
 * /api/self-status 返回的最小子集(其它字段 chip 不读)。
 *
 * 字段全部 optional,缺啥就走 fallback / offline 模式。
 */
export interface SelfStatusPayload {
  /** Git HEAD short(7-8 位). */
  headSha?: string | null;
  /** 当前 active daemon 的 build sha(若 daemon 未挂载就用 webBuildSha 兜底). */
  activeDaemonSha?: string | null;
  /** 当前 active daemon 颜色 — 蓝 / 绿 / null. */
  activeColor?: 'blue' | 'green' | null;
  /** active daemon 端口. */
  activePort?: number | null;
  /** standby controller 的模式 — 当前实例自己是 active 还是 standby. */
  mode?: 'active' | 'standby' | string | null;
  /** standby controller 自身颜色. */
  color?: 'blue' | 'green' | null;
  /** active 双 daemon 都活着 = switching 短窗口(supervisor 切换中). */
  bothDaemonsAlive?: boolean;
  /** Web bundle build sha(daemon 没暴露 activeDaemonSha 时降级). */
  webBuildSha?: string | null;
  /** 自更新历史最近一条(用来推断 uptime). */
  daemonUptimeSec?: number | null;
  /** drift 时与 git head 的 commit 距离(可选). */
  commitDistance?: number | null;
}

const NAV_TARGET = '/cds-settings#maintenance';

function shortSha(s: string | null | undefined, n = 8): string {
  if (!s) return '';
  return s.slice(0, n);
}

/** 判断两条 sha 是否同 commit(任一方向 startsWith 即同). */
export function shasMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * 根据 self-status payload 计算 ChipState。
 *
 *   payload === null ⇒ offline(轮询失败)
 *   bothDaemonsAlive ⇒ switching
 *   mode === standby ⇒ standby
 *   gitHead && activeDaemonSha 且不匹配 ⇒ drift
 *   else ⇒ normal
 */
export function computeChipState(payload: SelfStatusPayload | null): ChipState {
  if (!payload) {
    return {
      mode: 'offline',
      label: '离线',
      color: null,
      tooltip: '无法读取 /api/self-status — 请检查 daemon 进程',
      isError: true,
      shouldBlink: false,
      navigateTo: NAV_TARGET,
      highlightSelfUpdate: false,
    };
  }

  const activeColor: ChipColor = payload.activeColor ?? payload.color ?? null;
  const headSha = payload.headSha ?? '';
  const activeDaemonSha = payload.activeDaemonSha ?? payload.webBuildSha ?? '';

  // Switching:双 daemon 都活着的过渡态优先于 standby/normal/drift。
  if (payload.bothDaemonsAlive) {
    return {
      mode: 'switching',
      label: '切换中',
      color: activeColor,
      tooltip: '蓝绿切换中:supervisor 正在 promote 新 daemon',
      isError: false,
      shouldBlink: false,
      navigateTo: NAV_TARGET,
      highlightSelfUpdate: false,
    };
  }

  // Standby:当前实例是 standby(supervisor 还没 promote)。
  if (payload.mode === 'standby') {
    return {
      mode: 'standby',
      label: `standby · ${activeColor ?? '?'}`,
      color: activeColor,
      tooltip: 'standby 实例 — 不接业务流量,等 supervisor promote',
      isError: false,
      shouldBlink: false,
      navigateTo: NAV_TARGET,
      highlightSelfUpdate: false,
    };
  }

  // Drift:gitHead vs activeDaemonSha 不匹配。
  if (headSha && activeDaemonSha && !shasMatch(headSha, activeDaemonSha)) {
    const dist = payload.commitDistance;
    let tooltip = `git HEAD: ${shortSha(headSha)} · 当前部署: ${shortSha(activeDaemonSha)}`;
    if (typeof dist === 'number' && dist > 0) {
      tooltip += ` · 漂移 ${dist} 个 commit`;
    } else {
      tooltip += ' · 漂移';
    }
    return {
      mode: 'drift',
      label: `build: ${shortSha(activeDaemonSha)} · ${activeColor ?? '?'}`,
      color: activeColor,
      tooltip,
      isError: true,
      shouldBlink: true,
      navigateTo: NAV_TARGET,
      highlightSelfUpdate: true,
    };
  }

  // Normal:gitHead == activeDaemonSha,或两者缺一(单进程旧路径)。
  const sha = shortSha(activeDaemonSha || headSha);
  const labelParts: string[] = [];
  if (sha) labelParts.push(`build: ${sha}`);
  if (activeColor) labelParts.push(activeColor);
  const label = labelParts.join(' · ') || '未知';

  const tooltipLines: string[] = [];
  if (headSha) tooltipLines.push(`git HEAD: ${shortSha(headSha)}`);
  if (payload.activePort) tooltipLines.push(`active port: ${payload.activePort}`);
  if (typeof payload.daemonUptimeSec === 'number') {
    tooltipLines.push(`uptime: ${payload.daemonUptimeSec}s`);
  }

  return {
    mode: 'normal',
    label,
    color: activeColor,
    tooltip: tooltipLines.join('\n') || '已就绪',
    isError: false,
    shouldBlink: false,
    navigateTo: NAV_TARGET,
    highlightSelfUpdate: false,
  };
}

/**
 * 颜色 → 背景 Tailwind class(BuildShaChip.tsx 渲染时用)。
 *   blue → 蓝色,green → 青色,null → 灰
 *   isError 优先压住 → 红色
 */
export function chipBackgroundClass(state: ChipState): string {
  if (state.isError) return 'bg-red-500/20 text-red-200 border-red-500/40';
  if (state.mode === 'switching') return 'bg-amber-500/20 text-amber-200 border-amber-500/40';
  if (state.mode === 'standby') return 'bg-zinc-500/20 text-zinc-300 border-zinc-500/40';
  if (state.color === 'blue') return 'bg-blue-500/20 text-blue-200 border-blue-500/40';
  if (state.color === 'green') return 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40';
  return 'bg-zinc-500/20 text-zinc-300 border-zinc-500/40';
}

/** 30 秒轮询(C-6.3),hook 实现可重用此常量。 */
export const POLL_INTERVAL_MS = 30_000;
