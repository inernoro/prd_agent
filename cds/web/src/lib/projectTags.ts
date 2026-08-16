/**
 * 项目卡上的标签——渲染成**紧挨着项目名的一排图标标记**。
 *
 * 用户 2026-08-15：「这里给一些 label tag 让用户觉得这里是项目，我们的项目还没有
 * 专属的 tag 吧，我们得降低用户心智。」随后纠偏：「我的意思是项目名字旁边加一个
 * label tag 比如 icon 什么的。」——所以位置是**名字那一行**，形态是**图标**，
 * 不是名字下面再堆一行文字标签（那会让卡片更长、更难扫，与「降低心智」相反）。
 *
 * 三个刻意的决定：
 *
 * 1. **标签全部从真实字段推出来，不新建一套要人维护的自定义 tag。**
 *    `/api/projects` 返回的是整个 Project 加统计（`toSummary` 直接 spread），
 *    项目是不是接了 GitHub、有几条分支在跑、是不是暂停了、clone 有没有出错，
 *    这些全都已经在手里。派生标签零维护、永远和真相一致；让用户手打 tag 是
 *    把心智负担从「看不懂」换成「还得自己填」，方向反了。
 *
 * 2. **只出「此刻为真且值得一说」的标签。** 一张卡最多 3 枚，多了就成噪音，
 *    反而更难扫。优先级按「异常 > 身份 > 活跃度」排：暂停/出错这类必须先看见。
 *
 * 3. **图标不是把文字藏起来。** 每枚标记都带 title 悬停解释，带数字的（几个在跑）
 *    数字照常显示——图标只替掉「推送即部署」这种一看图就懂的定语，不替掉信息。
 *
 * 想要用户自定义的 tag 是另一件事（需要 Project 加字段 + 编辑入口 + 存储），
 * 不在这一层做。
 */

export type ProjectTagTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'brand';

/**
 * 标签的全集。列成联合类型是为了让「每枚标签配哪个图标」那张表
 * 由 TypeScript 兜底穷尽——这里加一枚标签而那边忘了配图标，编译就红。
 * 换成 `string` 的话漏配只会在运行时渲染成空白，看不出来。
 */
export type ProjectTagKey =
  | 'paused'
  | 'clone-error'
  | 'cloning'
  | 'shared-service'
  | 'manual'
  | 'github'
  | 'auto-deploy'
  | 'running'
  | 'idle';

export interface ProjectTag {
  /** 稳定 key，用于 React list、图标查表与测试断言。 */
  key: ProjectTagKey;
  label: string;
  tone: ProjectTagTone;
  /**
   * 挨着项目名的那枚标记里显示的文字。绝大多数标签是**纯图标**（留空），
   * 只有「几个在跑」这种带数字的才给一个极短的形式——数字丢了图标就没意义了。
   */
  short?: string;
  /** 悬停解释。标记本身只有一个图标，为什么这么标必须能问出来。 */
  title: string;
}

/** 只取推标签用得到的字段；多的字段不在这里罗列，避免与后端类型漂移。 */
export interface ProjectTagInput {
  kind?: 'git' | 'manual' | 'shared-service';
  githubRepoFullName?: string;
  githubAutoDeploy?: boolean;
  paused?: boolean;
  cloneStatus?: 'pending' | 'cloning' | 'ready' | 'error';
  legacyFlag?: boolean;
  runningServiceCount?: number;
  branchCount?: number;
}

const MAX_TAGS = 3;

/**
 * 推导一张项目卡该挂哪些标签。
 *
 * 顺序即优先级，超出 3 枚截断——所以异常状态必须排在前面，
 * 否则一个「暂停中」的项目会被三枚身份标签挤掉，用户看不见真正要紧的那条。
 */
export function projectTags(project: ProjectTagInput): ProjectTag[] {
  const tags: ProjectTag[] = [];

  // ── 异常优先 ───────────────────────────────────────────────
  if (project.paused === true) {
    tags.push({
      key: 'paused',
      label: '已暂停',
      tone: 'warn',
      title: '这个项目已暂停：push 不会自动建分支、不会自动部署',
    });
  }
  if (project.cloneStatus === 'error') {
    tags.push({
      key: 'clone-error',
      label: '克隆失败',
      tone: 'bad',
      title: '仓库还没克隆下来，分支预览和发布都用不了',
    });
  } else if (project.cloneStatus === 'cloning' || project.cloneStatus === 'pending') {
    tags.push({
      key: 'cloning',
      label: '克隆中',
      tone: 'neutral',
      title: '正在拉取仓库，完成后才能建分支预览',
    });
  }

  // ── 身份：这个项目是「什么」 ────────────────────────────────
  if (project.kind === 'shared-service') {
    tags.push({
      key: 'shared-service',
      label: '共享服务',
      tone: 'neutral',
      title: '共享服务型项目：供其它项目共用，本身不出分支预览',
    });
  } else if (project.kind === 'manual') {
    tags.push({
      key: 'manual',
      label: '手动接入',
      tone: 'neutral',
      title: '手动接入的项目，没有绑定 Git 仓库',
    });
  } else if (project.githubRepoFullName) {
    // 接了 GitHub 且开着自动部署，是「push 即预览」——这是 CDS 最核心的能力，
    // 值得单独标出来，而不是和普通 Git 项目混成一个标签。
    tags.push(project.githubAutoDeploy === false
      ? { key: 'github', label: 'GitHub', tone: 'neutral', title: '已连接 GitHub 仓库，但自动部署是关闭的' }
      : { key: 'auto-deploy', label: '推送即部署', tone: 'brand', title: '已连接 GitHub：push 之后自动建分支并部署预览' });
  }

  // ── 活跃度：现在有没有东西在跑 ──────────────────────────────
  const running = project.runningServiceCount || 0;
  if (running > 0) {
    tags.push({
      key: 'running',
      label: `${running} 个在跑`,
      // 这一枚必须保留数字：「在跑」和「跑了 35 个」不是同一条信息。
      short: String(running),
      tone: 'ok',
      title: `当前有 ${running} 个服务容器正在运行`,
    });
  } else if ((project.branchCount || 0) > 0) {
    tags.push({
      key: 'idle',
      label: '空闲',
      tone: 'neutral',
      title: `有 ${project.branchCount} 条分支，但当前没有正在运行的服务`,
    });
  }

  return tags.slice(0, MAX_TAGS);
}

/** 标记配色。走语义 token，两个主题自动翻。 */
export const PROJECT_TAG_TONE_CLASS: Record<ProjectTagTone, string> = {
  neutral: 'border-[hsl(var(--hairline-strong))] text-muted-foreground',
  ok: 'border-ok/35 bg-ok-soft text-ok',
  warn: 'border-warn/35 bg-warn-soft text-warn',
  bad: 'border-bad/35 bg-bad-soft text-bad',
  brand: 'border-primary/35 bg-primary-soft text-primary',
};
