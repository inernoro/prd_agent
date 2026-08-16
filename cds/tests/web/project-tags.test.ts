import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROJECT_TAG_TONE_CLASS, projectTags } from '../../web/src/lib/projectTags';

/**
 * 项目卡标签。用户 2026-08-15：「这里给一些 label tag 让用户觉得这里是项目，
 * 我们的项目还没有专属的 tag 吧，我们得降低用户心智。」
 *
 * 下面每个用例的输入都取自 `GET /api/projects` 的**真实响应形状**
 * （2026-08-15 线上抓的八个项目），不是编出来的。
 */

describe('标签从真实字段推出来', () => {
  it('接了 GitHub 且开着自动部署 → 推送即部署（CDS 的核心能力，单独标）', () => {
    // 线上 MAP 项目的真实字段
    const tags = projectTags({
      kind: 'git', githubRepoFullName: 'inernoro/prd_agent', githubAutoDeploy: true,
      runningServiceCount: 35, branchCount: 19,
    });
    expect(tags.map((t) => t.label)).toEqual(['推送即部署', '35 个在跑']);
    expect(tags[0].tone).toBe('brand');
    expect(tags[1].tone).toBe('ok');
  });

  it('接了 GitHub 但关了自动部署 → 只标 GitHub，不许说成推送即部署', () => {
    const tags = projectTags({ kind: 'git', githubRepoFullName: 'a/b', githubAutoDeploy: false });
    expect(tags.map((t) => t.label)).toEqual(['GitHub']);
    expect(tags[0].title).toContain('自动部署是关闭的');
  });

  it('共享服务 / 手动接入各有自己的身份标签', () => {
    expect(projectTags({ kind: 'shared-service' }).map((t) => t.label)).toEqual(['共享服务']);
    expect(projectTags({ kind: 'manual' }).map((t) => t.label)).toEqual(['手动接入']);
  });

  it('有分支但没有服务在跑 → 空闲；一个都没有 → 不编造活跃度标签', () => {
    expect(projectTags({ kind: 'git', branchCount: 1, runningServiceCount: 0 }).map((t) => t.label)).toEqual(['空闲']);
    expect(projectTags({ kind: 'git', branchCount: 0, runningServiceCount: 0 })).toEqual([]);
  });

  /** 线上「CDS Self」就是这样：git 项目但没接 GitHub。不许硬安一个身份标签。 */
  it('git 项目但没有仓库名时不出身份标签', () => {
    const tags = projectTags({ kind: 'git', cloneStatus: 'ready', branchCount: 1, runningServiceCount: 0 });
    expect(tags.map((t) => t.label)).toEqual(['空闲']);
  });
});

describe('异常状态必须先被看见', () => {
  /**
   * 一张卡最多 3 枚标签。异常排在最前面，否则「已暂停」会被身份标签挤掉——
   * 而那恰恰是用户最需要一眼看见的那条。线上「Claude SDK Sidecar Pool」就是
   * 暂停中的共享服务。
   */
  it('暂停中的共享服务：暂停排第一', () => {
    const tags = projectTags({ kind: 'shared-service', paused: true, cloneStatus: 'ready', runningServiceCount: 0, branchCount: 0 });
    expect(tags.map((t) => t.label)).toEqual(['已暂停', '共享服务']);
  });

  it('克隆失败是最高优先级的坏消息', () => {
    const tags = projectTags({
      kind: 'git', cloneStatus: 'error', githubRepoFullName: 'a/b', githubAutoDeploy: true,
      runningServiceCount: 3, branchCount: 2,
    });
    expect(tags[0].label).toBe('克隆失败');
    expect(tags[0].tone).toBe('bad');
    expect(tags).toHaveLength(3);
  });

  it('标签最多 3 枚，超出截断而不是撑破卡片', () => {
    const tags = projectTags({
      kind: 'git', paused: true, cloneStatus: 'error',
      githubRepoFullName: 'a/b', githubAutoDeploy: true, runningServiceCount: 9, branchCount: 5,
    });
    expect(tags).toHaveLength(3);
    // 截掉的是活跃度那一档，异常与身份都留住了
    expect(tags.map((t) => t.label)).toEqual(['已暂停', '克隆失败', '推送即部署']);
  });

  it('克隆中不是失败，不许标成红色', () => {
    for (const status of ['cloning', 'pending'] as const) {
      const tags = projectTags({ kind: 'git', cloneStatus: status });
      expect(tags[0].label).toBe('克隆中');
      expect(tags[0].tone).toBe('neutral');
    }
  });
});

describe('每枚标签都说得清为什么', () => {
  it('都有非空的 title（悬停解释），标签只有两三个字，理由要能查', () => {
    const all = [
      ...projectTags({ kind: 'git', githubRepoFullName: 'a/b', githubAutoDeploy: true, runningServiceCount: 2 }),
      ...projectTags({ kind: 'shared-service', paused: true }),
      ...projectTags({ kind: 'manual', branchCount: 3 }),
      ...projectTags({ kind: 'git', cloneStatus: 'error' }),
      ...projectTags({ kind: 'git', cloneStatus: 'cloning' }),
      ...projectTags({ kind: 'git', githubRepoFullName: 'a/b', githubAutoDeploy: false }),
    ];
    expect(all.length).toBeGreaterThan(6);
    for (const tag of all) {
      expect(tag.title.length, `标签「${tag.label}」没有解释`).toBeGreaterThan(4);
      expect(tag.key).toBeTruthy();
    }
    // key 在同一张卡内不重复（React list key）
    const one = projectTags({ kind: 'git', paused: true, githubRepoFullName: 'a/b', runningServiceCount: 1 });
    expect(new Set(one.map((t) => t.key)).size).toBe(one.length);
  });
});

describe('接线与配色', () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), '../cds/web/src/pages/ReleaseConsolePage.tsx'),
    'utf8',
  );
  const LIB = fs.readFileSync(
    path.resolve(process.cwd(), '../cds/web/src/lib/projectTags.ts'),
    'utf8',
  );

  /** 判据写好却没渲染到卡上，是本仓库反复栽的「链路只建到一半」。 */
  it('项目卡真的渲染了标记', () => {
    expect(PAGE).toContain('<ProjectTagMarks project={item} />');
    expect(PAGE).toContain('projectTags(project)');
    expect(PAGE).toContain('PROJECT_TAG_TONE_CLASS[tag.tone]');
  });

  /**
   * 用户 2026-08-16 纠偏：「我的意思是项目名字旁边加一个 label tag 比如 icon 什么的。」
   * 位置是**名字那一行**——上一版把它放在仓库名下面另起一行，不是用户要的。
   * 这里断言标记与名字在同一个横向容器里，且排在名字之后。
   */
  it('标记挂在项目名同一行，不是名字下面另起一行', () => {
    const nameLine = PAGE.slice(
      PAGE.indexOf('{item.name || item.id}'),
      PAGE.indexOf('<ProjectTagMarks project={item} />'),
    );
    // 名字与标记之间只隔着闭合标签，中间没有插入仓库名那一行
    expect(nameLine).not.toContain('githubRepoFullName');
    expect(nameLine.length).toBeLessThan(120);
    // 承载它俩的那层是横向 flex（竖排就又变成「下面一行」了）
    const wrapperStart = PAGE.lastIndexOf('<span className="flex w-full min-w-0 items-center gap-1.5">', PAGE.indexOf('{item.name || item.id}'));
    expect(wrapperStart).toBeGreaterThan(0);
    // 名字可截断、标记不参与压缩，长名字不会把标记挤没
    expect(PAGE).toContain('min-w-0 flex-1 truncate text-[13px] font-medium');
    expect(PAGE).toContain('flex shrink-0 items-center gap-1');
  });

  /** 图标表漏配一枚 → 页面上是个空框，看不出来。所以让 TS + 这条一起兜。 */
  it('每一枚标签都配了图标，一枚不漏', () => {
    const table = PAGE.slice(
      PAGE.indexOf('const PROJECT_TAG_ICON'),
      PAGE.indexOf('function ProjectTagMarks'),
    );
    expect(table).toContain('Record<ProjectTagKey, LucideIcon>');
    const everyKey = new Set<string>();
    for (const input of [
      { kind: 'git', paused: true, cloneStatus: 'error', githubRepoFullName: 'a/b', runningServiceCount: 1 },
      { kind: 'git', cloneStatus: 'cloning', githubRepoFullName: 'a/b', githubAutoDeploy: false },
      { kind: 'git', githubRepoFullName: 'a/b', githubAutoDeploy: true, branchCount: 1 },
      { kind: 'shared-service' }, { kind: 'manual', runningServiceCount: 4 },
      { kind: 'git', branchCount: 2, runningServiceCount: 0 },
    ] as const) {
      for (const tag of projectTags(input)) everyKey.add(tag.key);
    }
    expect(everyKey.size).toBe(9); // 标签全集
    for (const key of everyKey) {
      const quoted = /^[a-z]+$/.test(key) ? key : `'${key}'`;
      expect(table, `标签 ${key} 没配图标`).toMatch(new RegExp(`${quoted}:\\s*[A-Z]`));
    }
  });

  /** 图标不能把信息藏掉：带数字的那枚必须把数字显示出来，其余靠 title + aria-label。 */
  it('数字不被图标吃掉，且每枚标记都能被读屏念出来', () => {
    expect(projectTags({ kind: 'git', runningServiceCount: 35 })[0].short).toBe('35');
    expect(projectTags({ kind: 'git', branchCount: 1, runningServiceCount: 0 })[0].short).toBeUndefined();
    expect(PAGE).toContain('{tag.short ?');
    expect(PAGE).toContain('aria-label={tag.label}');
    expect(PAGE).toContain('title={tag.title}');
  });

  it('五种色调都有定义，且全部走语义 token（两个主题自动翻）', () => {
    for (const tone of ['neutral', 'ok', 'warn', 'bad', 'brand'] as const) {
      expect(PROJECT_TAG_TONE_CLASS[tone], `缺 ${tone} 配色`).toBeTruthy();
    }
    for (const cls of Object.values(PROJECT_TAG_TONE_CLASS)) {
      // 不许出现硬编码调色板（换主题时不跟着走）
      expect(cls).not.toMatch(/-(?:red|emerald|amber|sky|green|blue|orange)-\d{2,3}/);
    }
  });

  /**
   * 这一层刻意**不**引入用户自定义 tag：那需要 Project 加字段 + 编辑入口 + 存储，
   * 而且把「看不懂」的负担换成「还得自己填」，与「降低心智」相反。
   * 标签只许来自已有字段。
   */
  it('不引入需要用户维护的自定义 tag 字段', () => {
    expect(LIB).not.toMatch(/customTags|userTags|labels\?:/);
  });
});
