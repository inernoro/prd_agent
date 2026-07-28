/**
 * statusView — 状态页（/status）的纯判定层。
 *
 * 抽出来的原因有二：
 *   1. cds/web 没有 jsdom / testing-library 设施，页面逻辑只有做成纯函数才测得到
 *      （回归见 tests/web/status-page-view-state.test.ts）；
 *   2. 「加载中 / 有数据 / 失败」必须是互斥的三态。旧实现只看 summary 是否为 null，
 *      首次加载失败时既显示错误横幅又永远转着骨架屏，屏幕同时说两件矛盾的事，
 *      读屏用户还会一直听到「正在读取存活监控数据」。
 */

export type StatusViewPhase = 'loading' | 'ready' | 'error';

/**
 * 三态判定：
 *   - 有数据 → ready（哪怕本次轮询失败也保留旧数据，只在顶部提示，避免画面清空）；
 *   - 无数据 + 有错误 → error（渲染引导式错误卡片，绝不再渲染骨架）；
 *   - 其余 → loading（只有这一相位才允许出现骨架屏）。
 */
export function resolveStatusViewPhase(input: { hasSummary: boolean; error: string | null }): StatusViewPhase {
  if (input.hasSummary) return 'ready';
  if (input.error) return 'error';
  return 'loading';
}

export interface StatusLoadErrorView {
  /** 一句话讲清「哪里出了问题」 */
  title: string;
  /** 下一步怎么办，末尾始终带上原始错误文本，便于排障 */
  hint: string;
}

/**
 * 把接口错误翻译成可行动的说明。原始错误文本永远保留在 hint 里，
 * 不允许被「加载失败」四个字吞掉。
 */
export function describeStatusLoadError(message: string): StatusLoadErrorView {
  const raw = (message || '').trim() || '未知错误';
  const lower = raw.toLowerCase();

  if (/401|403|unauthor|forbidden|未授权|登录/i.test(raw)) {
    return {
      title: '登录态可能已失效',
      hint: `请重新登录 CDS 后再打开本页。原始错误：${raw}`,
    };
  }
  if (/404|not found/i.test(raw)) {
    return {
      title: '当前 CDS 实例没有存活监控接口',
      hint: `/api/uptime/* 未注册，多半是 CDS 版本较旧，更新后重启即可。原始错误：${raw}`,
    };
  }
  if (lower.includes('failed to fetch') || /networkerror|econnrefused|超时|timeout|network/i.test(raw)) {
    return {
      title: '连接 CDS 服务失败',
      hint: `请确认 CDS 进程在跑、网络可达，然后点「重新加载」。原始错误：${raw}`,
    };
  }
  return {
    title: '读取存活监控数据失败',
    hint: `可以先点「重新加载」重试；持续失败时看一眼 CDS 日志。原始错误：${raw}`,
  };
}
