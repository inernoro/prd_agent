import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RELEASE_CENTER_SECTIONS, releaseCenterSection } from '../../web/src/lib/releaseCenter';

/**
 * 发布中心 vs 设计稿 design_handoff_release_center 的**元素齐全度核对**。
 *
 * 用户 2026-08-14：「按照稿子做，你不要自由发挥……我需要一比一复刻，至少元素一致，
 * 而且你得校验看看」。前一版我用现成的四个 tab 顶替了稿子的四个分区，元素对不上。
 * 这条守卫把稿子里点名的元素逐条列出来——**少一个就红**，省得下次又靠印象说「做了」。
 *
 * 只核对「元素在不在」，不核对像素：像素靠截图看，元素靠这里兜。
 */

const WEB = path.resolve(process.cwd(), '../cds/web/src');
const read = (rel: string): string => fs.readFileSync(path.join(WEB, rel), 'utf8');

const page = read('pages/ReleaseCenterPage.tsx');
const matrix = read('pages/release-center/FleetMatrix.tsx');
const config = read('pages/release-center/EnvConfigSection.tsx');
const health = read('pages/release-center/HealthSection.tsx');
const evidence = read('pages/release-center/EvidenceSection.tsx');

describe('稿子 §0 全局外壳', () => {
  it('顶栏：标题 + release center 副标题 + 项目胶囊 + 新建环境 + 发布控制台主按钮', () => {
    expect(page).toContain('release center · 环境生命周期');
    expect(page).toContain('aria-label="项目"');
    expect(page).toContain('新建环境');
    expect(page).toContain('发布控制台');
  });

  it('分区导航五格，且带计数角标', () => {
    for (const label of ['全环境矩阵', '环境与配置', '自动发布规则', '健康监测', '证据归档']) {
      expect(page, `缺分区 ${label}`).toContain(`label: '${label}'`);
    }
    expect(page).toContain('sectionBadge');
    expect(page).toContain('未监测');
  });

  /** 稿子 Interactions：分区映射成 `?section=…`，一条链接就能把这一屏发给别人。 */
  it('分区可分享：?section= 双向绑定，非法值退回 fleet', () => {
    expect(RELEASE_CENTER_SECTIONS).toEqual(['fleet', 'config', 'rules', 'health', 'evidence']);
    for (const id of RELEASE_CENTER_SECTIONS) {
      expect(releaseCenterSection(new URLSearchParams(`section=${id}`))).toBe(id);
    }
    expect(releaseCenterSection(new URLSearchParams())).toBe('fleet');
    expect(releaseCenterSection(new URLSearchParams('section=nope'))).toBe('fleet');
    // 页面两头都接上了：初值读 URL，切换写回 URL（replace，不堆历史）
    expect(page).toContain('useState<CenterSection>(() => releaseCenterSection(searchParams))');
    expect(page).toContain('setSearchParams(');
    expect(page).toContain('{ replace: true }');
  });
});

/**
 * 分区必须真的挂上对应组件——这条守卫是补上一次的漏。
 *
 * 上一轮我把三个分区组件都写好了、也都 import 了，parity 守卫逐条读文件内容全绿，
 * 部署后打开「证据归档」看到的却还是旧的 ReleaseTimeline：EvidenceSection 被渲染在
 * 它下面，第一屏根本看不见。**只读组件文件的守卫证明不了页面在用它**
 * （predicate-and-wiring-discipline 形状 2）。所以这里断言的是「哪个分区渲染哪个组件」，
 * 并且明确禁止旧组件回到这几个分区里。
 */
describe('分区 → 组件的接线', () => {
  const branchOf = (id: string): string => {
    const start = page.indexOf(`section === '${id}' ? (`);
    expect(start, `页面里找不到 section === '${id}' 的分支`).toBeGreaterThanOrEqual(0);
    return page.slice(start, start + 1400);
  };

  it('每个分区渲染稿子指定的那个组件', () => {
    expect(branchOf('fleet')).toContain('<FleetMatrix');
    expect(branchOf('config')).toContain('<EnvConfigSection');
    expect(branchOf('health')).toContain('<HealthSection');
    expect(branchOf('evidence')).toContain('<EvidenceSection');
  });

  it('证据归档只有一张表：旧的 ReleaseTimeline 不许再出现在本页', () => {
    // 同一批 run 渲染两遍（时间线 + 六列表）比任意一张都糟。时间线独有的能力
    // 已折进 EvidenceSection，所以本页连 import 都不该再有值引用。
    expect(page).not.toContain('<ReleaseTimeline');
    expect(page).toContain("import type { TimelineFilter }");
  });

  it('筛选口径只有一份：页面不再自己过滤一遍 failed', () => {
    // 页面先过滤、再把过滤结果交给同样会过滤的分区，会让「全部 N」显示成过滤后的条数。
    expect(page).not.toContain('historyRuns');
    expect(evidence).toContain('isReleaseFailed(run.status)');
  });
});

describe('稿子 §1 监控条', () => {
  it('状态点 + 判断句 + 数据截至 + 四指标 + 去处理按钮', () => {
    expect(page).toContain('cds-verdict-pulse');
    expect(page).toContain('buildFleetVerdict');
    expect(page).toContain('数据截至');
    expect(page).toContain('buildFleetMetrics');
    expect(page).toContain('去处理 ');
    // 判断句里的环境名必须是可点的链接（下钻到该环境的配置）
    expect(page).toContain('underline decoration-dotted');
  });
});

describe('稿子 §2 全环境矩阵', () => {
  it('十列表头齐全', () => {
    for (const col of ['环境', '类型', '健康', '可用率 24H', '线上 SHA', '落后主干', '最近一次发布', 'DORA 30D', '能力', '操作']) {
      expect(matrix, `缺列 ${col}`).toContain(`>${col}</span>`);
    }
  });

  it('列宽照标注：1fr/76/104/92/92/116/170/170/110/192', () => {
    expect(matrix).toContain("'minmax(200px,1fr) 76px 104px 92px 92px 116px 170px 170px 110px 192px'");
  });

  it('五种排序 chip 与默认严重度', () => {
    for (const label of ['严重度', '名称', '类型', '落后提交', '最近发布']) {
      expect(read('lib/releaseFleet.ts'), `缺排序 ${label}`).toContain(`label: '${label}'`);
    }
    expect(page).toContain("useState<FleetSortKey>('severity')");
  });

  it('单元格文案分级：类型 / 健康 / 缺数据都按稿子的词', () => {
    const fleet = read('lib/releaseFleet.ts');
    for (const word of ['生产', '预发', '其它', '健康', '失败', '未监测', '已是最新', '无法计算']) {
      expect(fleet, `缺文案 ${word}`).toContain(`'${word}'`);
    }
    expect(matrix).toContain('未发布过');
    expect(matrix).toContain('从未发布');
    expect(matrix).toContain('样本不足');
    expect(matrix).toContain('近 30 天不足 3 次发布');
  });

  it('徽标与能力列：主目标 / 未启用 / 可回滚 / 可提升 / 无', () => {
    for (const word of ['主目标', '未启用', '可回滚', '可提升 ']) {
      expect(matrix, `缺徽标 ${word}`).toContain(word);
    }
    expect(matrix).toContain(">无</span>");
  });

  it('操作列三个控件，停用与不可回滚各自置灰并说明原因', () => {
    expect(matrix).toContain("'提升版本' : '发布'");
    expect(matrix).toContain('回滚');
    expect(matrix).toContain('该环境已停用，启用后才能发布');
    expect(matrix).toContain('这个环境没有可回滚的历史版本');
    expect(matrix).toContain('opacity-45');
    expect(matrix).toContain('opacity-40');
  });

  it('行状态：失败行整行底色、未启用行降透明、整行可点且行内按钮 stopPropagation', () => {
    expect(matrix).toContain("env.health === 'failed' ? 'bg-red-500/[0.05]'");
    expect(matrix).toContain("env.enabled ? '' : 'opacity-55'");
    expect(matrix).toContain('event.stopPropagation()');
  });

  it('窄屏塌成单列卡片，按钮 44px 命中区，不横向滚动', () => {
    expect(matrix).toContain("tall ? 'h-11'");
    expect(matrix).toContain('grid-cols-[92px_minmax(0,1fr)]');
    expect(matrix).not.toContain('overflow-x-auto');
  });
});

describe('稿子 §3 环境与配置（唯一写入口）', () => {
  it('头部：标题 + 唯一写入口徽标 + 未保存提示 + 保存策略', () => {
    expect(config).toContain('唯一写入口');
    expect(config).toContain('有未保存更改');
    expect(config).toContain('保存策略');
  });

  it('五个字段齐全，命令类走代码底色', () => {
    for (const label of ['发布模式', '站点目录', '部署命令', '健康检查地址', '回滚命令']) {
      expect(config, `缺字段 ${label}`).toContain(`label="${label}"`);
    }
    expect(config).toContain('CODE_CONTROL');
    expect(config).toContain('未配置');
    expect(config).toContain('该环境不支持回滚');
  });

  /**
   * 真实数据里部署命令是整段 shell 脚本。`<input>` 设值时会吃掉换行，
   * 用户改一个字母保存下去就把生产脚本压成了一行——编译、类型、测试全都发现不了。
   */
  it('命令类字段必须是 textarea，不能用 input（换行会被吃掉）', () => {
    for (const field of ['deployCommand', 'rollbackCommand']) {
      const at = config.indexOf(`value={draft.${field}}`);
      expect(at, `找不到 ${field} 的控件`).toBeGreaterThanOrEqual(0);
      const control = config.slice(Math.max(0, at - 200), at);
      expect(control, `${field} 用了 input，多行脚本会被压平`).toContain('<textarea');
    }
    // 生效序列预览要限高，否则整段脚本会把下面的内容挤没
    expect(config).toContain('max-h-[260px]');
  });

  it('两个开关卡片，轨道与滑块尺寸照稿子', () => {
    expect(config).toContain('设为主目标');
    expect(config).toContain('启用该环境');
    expect(config).toContain('h-[19px] w-[34px]');
    expect(config).toContain('h-[15px] w-[15px]');
    expect(config).toContain('left: on ? 17 : 2');
  });

  it('底部生效序列预览，缺命令时明说发不了', () => {
    expect(config).toContain('生效序列预览');
    expect(config).toContain('curl -sf');
    expect(config).toContain('未配置部署命令，保存前无法发布');
  });

  /** 草稿按环境隔离：不隔离的话在 A 改一半切到 B，会把 A 的值保存到 B 上。 */
  it('换环境重置草稿', () => {
    expect(config).toContain('setDraft(draftOf(row))');
    expect(config).toContain('[row.target.id]');
  });
});

describe('稿子 §5 健康监测', () => {
  it('左卡片 420px 探测配置四项齐全', () => {
    expect(health).toContain('xl:grid-cols-[420px_minmax(0,1fr)]');
    for (const label of ['检查地址', '探测间隔', '超时', '连续失败阈值']) {
      expect(health, `缺 ${label}`).toContain(`>${label}</dt>`);
    }
  });

  it('未监测提示块说明「留空而非 0」', () => {
    expect(health).toContain('留空而不是写 0');
  });

  it('右卡片 24 根柱子，尺寸与配色照稿子；未监测不画柱子', () => {
    expect(health).toContain('segments=24');
    expect(health).toContain("gap-[3px]");
    expect(health).toContain('h-[34px]');
    expect(health).toContain('rounded-t-[2px]');
    expect(health).toContain('bg-red-500');
    expect(health).toContain('bg-amber-500');
    expect(health).toContain('bg-emerald-500');
    expect(health).toContain('未配置健康检查地址，趋势不可绘制');
  });
});

describe('稿子 §6 证据归档', () => {
  it('六列 + 两个按钮，列宽照标注', () => {
    expect(evidence).toContain("'150px 130px 92px 104px 88px minmax(0,1fr) auto'");
    for (const col of ['时间', '环境', 'SHA', '结果', '耗时', '操作人']) {
      expect(evidence, `缺列 ${col}`).toContain(`>${col}</span>`);
    }
    expect(evidence).toContain('日志');
    expect(evidence).toContain('验收报告');
    expect(evidence).toContain('cursor-not-allowed');
  });

  it('底部日志预览 + 保留策略写在分区头部', () => {
    expect(evidence).toContain('日志预览');
    expect(evidence).toContain('保留 90 天，生产永久');
  });

  /**
   * 重构掉 EvidenceTab 时这两块曾被静默删掉：后端还在记录、接口还在返回，
   * 前端却没人渲染了（形状 2 的反面——链路留了个没有消费方的头）。
   */
  it('稿子之外仍保留：步骤条 + 配置变更历史（后端仍在供数，不许悄悄丢）', () => {
    expect(evidence).toContain('resolveReleaseSteps(run)');
    expect(evidence).toContain('/changes?limit=20');
    expect(evidence).toContain('配置变更历史');
    expect(evidence).toContain('RELEASE_CHANGE_KIND_LABELS');
    // 逐条 before → after，不许退化成一句「配置更新」
    expect(evidence).toContain('field.before');
    expect(evidence).toContain('field.after');
  });
});

describe('稿子「硬性约束」', () => {
  it('禁止暗色字面量：新分区一律走 token', () => {
    for (const [name, source] of [['matrix', matrix], ['config', config], ['health', health], ['evidence', evidence]] as const) {
      expect(source, `${name} 出现了暗色字面量`).not.toMatch(/#(0[a-f0-9]{5}|1[a-f0-9]{5})\b/i);
      expect(source, `${name} 出现了裸 var(--…) 兜底色`).not.toMatch(/var\(--[a-z-]+,\s*#/i);
    }
  });

  it('发布中心不执行发布：新分区里没有发起发布的调用', () => {
    expect(matrix).not.toContain('apiRequest');
    // 证据分区读变更历史（GET）是允许的，发起发布不允许。
    expect(evidence).not.toContain('/runs');
    expect(evidence).not.toMatch(/method:\s*'(POST|PUT|DELETE)'/);
    // 配置分区只写策略，不发布
    expect(config).toContain("method: 'PATCH'");
    expect(config).not.toContain('/runs');
  });
});
