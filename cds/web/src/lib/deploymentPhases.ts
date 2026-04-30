/*
 * deploymentPhases — 把一段部署日志（行数组）+ 终态 + 错误信息
 * 归纳成 4 个阶段（拉取代码 / 构建镜像 / 启动服务 / 健康检查）
 * 的状态树，供 Drawer / 详情页的「Active deployment」面板渲染。
 *
 * 设计要点：
 * - 阶段顺序固定（prepare → build → deploy → verify），按行扫描时
 *   只能向前推进，不会因为后面又出现 prepare 关键词而回退；这跟
 *   实际部署 SSE 事件的时间线一致。
 * - 失败传播：第一条匹配 /error|失败|fail/i 的日志归到当前阶段，
 *   该阶段标 error，后续阶段保持 pending（不会自动失败）。
 *   如果 finalStatus === 'error' 但 log 里没找到 error 行，把
 *   最后一个被识别到的阶段标 error，保证「红行」一定存在。
 * - 保守降级：log 完全识别不到任何阶段（空 / 全是无关行）时，
 *   返回单个 build 阶段，避免短日志被强行套上 4 阶段空架子。
 * - errorMessage：调用方传入的兜底错误（branch.errorMessage 或
 *   action.message），会被 inject 到失败阶段的 errorHint，让阶段
 *   树即使日志稀薄也能显示原因。
 */

export type PhaseKey = 'prepare' | 'build' | 'deploy' | 'verify';
export type PhaseStatus = 'pending' | 'running' | 'success' | 'error';

export interface PhaseState {
  key: PhaseKey;
  label: string;
  status: PhaseStatus;
  durationMs?: number;
  lastLine?: string;
  errorHint?: string;
}

const PHASE_LABELS: Record<PhaseKey, string> = {
  prepare: '拉取代码',
  build: '构建镜像',
  deploy: '启动服务',
  verify: '健康检查',
};

const PHASE_ORDER: PhaseKey[] = ['prepare', 'build', 'deploy', 'verify'];

const PHASE_PATTERNS: Record<PhaseKey, RegExp> = {
  prepare: /clone|checkout|git|pull|代码|拉取/i,
  build: /build|install|compile|tsc|npm|pnpm|dotnet|image|docker|镜像|构建/i,
  deploy: /run|start|listen|启动|执行/i,
  verify: /health|ready|探活|verify|健康/i,
};

const ERROR_PATTERN = /error|失败|fail/i;

interface PhaseAccumulator {
  matched: boolean;
  firstIndex: number;
  lastIndex: number;
  lastLine?: string;
  errorLine?: string;
}

function classifyLine(line: string): PhaseKey | null {
  // 顺序遍历 PHASE_ORDER，让一行同时匹配多个 pattern 时取
  // "更靠后"的阶段（如 "docker run" 同时命中 build 和 deploy，
  // 应归到 deploy；"healthcheck after deploy" 应归到 verify）。
  let matched: PhaseKey | null = null;
  for (const key of PHASE_ORDER) {
    if (PHASE_PATTERNS[key].test(line)) {
      matched = key;
    }
  }
  return matched;
}

export interface DeriveBranchPhasesInput {
  log: string[];
  finalStatus: 'running' | 'success' | 'error';
  errorMessage?: string;
}

export function deriveBranchPhases(
  log: string[],
  finalStatus: 'running' | 'success' | 'error',
  errorMessage?: string,
): PhaseState[] {
  const lines = (log || []).map((line) => (line || '').trim()).filter((line) => line.length > 0);

  // 扫描 log，给每个阶段累加首末位置 / 最后一行 / 错误行
  const acc: Record<PhaseKey, PhaseAccumulator> = {
    prepare: { matched: false, firstIndex: -1, lastIndex: -1 },
    build: { matched: false, firstIndex: -1, lastIndex: -1 },
    deploy: { matched: false, firstIndex: -1, lastIndex: -1 },
    verify: { matched: false, firstIndex: -1, lastIndex: -1 },
  };

  let highWaterMark = -1; // PHASE_ORDER 里的最大 index，单调递增
  lines.forEach((line, index) => {
    const classified = classifyLine(line);
    if (!classified) return;
    const order = PHASE_ORDER.indexOf(classified);
    // 只能往前推进，已经走到 verify 的不会回退到 prepare
    const target = order >= highWaterMark ? classified : PHASE_ORDER[highWaterMark];
    highWaterMark = Math.max(highWaterMark, order);

    const entry = acc[target];
    entry.matched = true;
    if (entry.firstIndex < 0) entry.firstIndex = index;
    entry.lastIndex = index;
    entry.lastLine = line;
    if (!entry.errorLine && ERROR_PATTERN.test(line)) {
      entry.errorLine = line;
    }
  });

  const matchedKeys = PHASE_ORDER.filter((key) => acc[key].matched);

  // 保守降级：完全识别不到任何阶段时，返回单个 build 占位
  if (matchedKeys.length === 0) {
    const fallbackLine = lines.length > 0 ? lines[lines.length - 1] : undefined;
    const status: PhaseStatus = finalStatus === 'running' ? 'running' : finalStatus;
    return [
      {
        key: 'build',
        label: '构建',
        status,
        lastLine: fallbackLine,
        errorHint: status === 'error' ? errorMessage || fallbackLine : undefined,
      },
    ];
  }

  // 把识别到的阶段 + 它们之间的隐含成功阶段全部还原成 4 阶段标准列。
  // 例如只看到 prepare 和 deploy 但没 build：deploy 既然走到了，
  // build 必然成功过；即使日志没显式提到，也补一行 success。
  const lastMatchedOrder = PHASE_ORDER.indexOf(matchedKeys[matchedKeys.length - 1]);
  const phases: PhaseState[] = [];

  // 找到首个含 errorLine 的阶段
  const errorPhaseIndex = matchedKeys.findIndex((key) => acc[key].errorLine);
  let resolvedErrorOrder = errorPhaseIndex >= 0
    ? PHASE_ORDER.indexOf(matchedKeys[errorPhaseIndex])
    : -1;

  // finalStatus=error 但 log 没找到 error 关键词时，
  // 把最后一个被识别到的阶段标 error
  if (finalStatus === 'error' && resolvedErrorOrder < 0) {
    resolvedErrorOrder = lastMatchedOrder;
  }

  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const key = PHASE_ORDER[i];
    const label = PHASE_LABELS[key];
    let status: PhaseStatus;
    let lastLine: string | undefined;
    let errorHint: string | undefined;

    if (resolvedErrorOrder >= 0) {
      if (i < resolvedErrorOrder) {
        status = 'success';
      } else if (i === resolvedErrorOrder) {
        status = 'error';
        errorHint = acc[key].errorLine || errorMessage || acc[key].lastLine;
      } else {
        status = 'pending';
      }
    } else if (finalStatus === 'running') {
      if (i < lastMatchedOrder) {
        status = 'success';
      } else if (i === lastMatchedOrder) {
        status = 'running';
      } else {
        status = 'pending';
      }
    } else if (finalStatus === 'success') {
      // 部署完成，所有阶段视为已通过
      status = 'success';
    } else {
      // 不应到这里，但保持 type-safe
      status = 'pending';
    }

    if (acc[key].matched) {
      lastLine = acc[key].lastLine;
    }

    phases.push({
      key,
      label,
      status,
      lastLine,
      errorHint,
    });
  }

  return phases;
}

export function phaseLabel(key: PhaseKey): string {
  return PHASE_LABELS[key];
}
