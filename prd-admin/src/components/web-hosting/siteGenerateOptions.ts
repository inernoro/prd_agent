/**
 * 生成弹窗「写要求」这一步用到的两张注册表：预设要求与执行器卡片文案。
 *
 * 执行器卡片按 runtime id 查表（注册表模式，不在组件里写 switch）。表里没有的执行器
 * 仍然能被选：卡片退回用 capability.label，并且不承诺任何耗时。
 */

export interface PresetRequest {
  label: string;
  text: string;
}

/** 点一下就把整段要求填进文本框；用户可以接着改。 */
export const PRESET_REQUESTS: readonly PresetRequest[] = [
  {
    label: '技术评审页',
    text: '做成给团队评审用的单页：先一句话说清要解决什么问题，再讲现状瓶颈、改造方案和上线风险，最后列出待决策事项。风格干净克制。',
  },
  {
    label: '宣讲页',
    text: '做成面向全员宣讲的单页：开头一句话讲清这件事为什么重要，再用三到四个板块讲变化、收益和需要大家配合的地方，结尾给出时间表。语气有感染力但不浮夸。',
  },
  {
    label: '产品介绍',
    text: '做成给潜在客户看的产品介绍页：首屏讲清产品解决什么问题，再突出三个核心价值和一个落地案例，最后给出下一步行动。风格克制、可信。',
  },
  {
    label: '发布说明',
    text: '做成版本发布说明页：先列本次最重要的三项变化，再按模块分组说明新增、优化和修复，最后写升级注意事项。便于快速扫读。',
  },
  {
    label: '活动落地页',
    text: '做成活动落地页：首屏给出活动主题、时间和报名入口，再讲活动亮点、日程和嘉宾，结尾重复报名入口。视觉有活力、层次清楚。',
  },
];

export interface RuntimeCardCopy {
  title: string;
  badge: string;
  /** 两个大号数字：耗时量级与调用方式。 */
  facts: Array<{ value: string; unit: string }>;
  description: string;
  /** 「开始生成」旁那句预期说明。 */
  footnote: string;
}

export const RUNTIME_CARD_REGISTRY: Record<string, RuntimeCardCopy> = {
  'map-gateway': {
    title: '快速生成',
    badge: '日常推荐',
    facts: [
      { value: '约 1', unit: '分钟' },
      { value: '1', unit: '次模型调用' },
    ],
    description: '一次写完整页，内容最全、速度最快；版式以卡片和列表为主。',
    footnote: '快速生成约 1 分钟，边写边在右侧预览。',
  },
  'open-design': {
    title: '精细设计',
    badge: 'OpenDesign',
    facts: [
      { value: '9–12', unit: '分钟' },
      { value: '多', unit: '轮自查修复' },
    ],
    description: '在隔离环境里先定结构、再写、再逐项自查修复；对比表、可展开块更多。可以后台运行。',
    footnote: '精细设计约 9–12 分钟。关掉窗口任务也会继续，重新打开「生成网页」可接着看进度。',
  },
};

/** 卡片排列顺序：已知执行器按表里的顺序，未知的排在后面。 */
export function orderRuntimeCards<T extends { id: string }>(runtimes: readonly T[]): T[] {
  const known = Object.keys(RUNTIME_CARD_REGISTRY);
  return [...runtimes].sort((a, b) => {
    const ai = known.indexOf(a.id);
    const bi = known.indexOf(b.id);
    return (ai < 0 ? known.length : ai) - (bi < 0 ? known.length : bi);
  });
}

export function runtimeCardTitle(runtime: { id: string; label: string }): string {
  return RUNTIME_CARD_REGISTRY[runtime.id]?.title ?? runtime.label;
}

/** 用文件名当默认标题时去掉扩展名。 */
export function titleFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
}
