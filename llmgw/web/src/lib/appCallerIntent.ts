// 从一句「我想要做什么」推出 appCallerCode。
//
// 为什么要有这层：appCallerCode 回答「为什么调用」，格式是 `{应用}.{用途}::chat|vision`
// （console-api 的 IsValidSelfServiceAppCaller：至少两段、每段小写字母开头、只允许
// a-z0-9-，`::` 后缀必须等于 requestType）。以前 Quickstart 直接把第二段预填成
// `quickstart`，于是每个人签出来的码都长一样、谁也说不出这把 key 是干嘛的——
// 用户三次反馈「不要直接给一个随机的 xxxquickstart」。现在改成：**先说要做什么，
// 说清楚了才颁发**，码的每一段都能指回他自己写的那句话。
//
// 判定是规则式的、可解释的，不调模型：
//   - 一句话要同时说清「谁在调用」和「要做什么」，正好对上码的两段；
//   - 命中的关键词原样回显（「来自『桌面』」），用户能核对系统凭什么这么判；
//   - 认不出来就明说认不出来，让他从有限清单里挑一个，不猜、不兜底成占位值。
//
// 关键词表刻意有限且各自封闭：这不是自然语言理解，是一张「有限枚举 + 别名」表。
// 要扩就加词条，不要往里塞正则或嵌套语法（AGENTS.md 5.5 的自由文本解析器熔断）。

export type RequestType = 'chat' | 'vision';

export type IntentFacet = {
  /** appCallerCode 里的那一段，必须是合法 kebab。 */
  code: string;
  label: string;
  /** 全小写；匹配用 includes，所以中英文可以混在一张表里。 */
  keywords: string[];
};

export type IntentTask = IntentFacet & { requestType: RequestType };

export type MatchedFacet<T extends IntentFacet> = T & { matched: string };

export type IntentAnalysis = {
  /** 归一化后的原句，供调用方回显。 */
  text: string;
  /** 太短就不算「说清楚了」——两三个字推不出两段码。 */
  tooShort: boolean;
  actor: MatchedFacet<IntentFacet> | null;
  task: MatchedFacet<IntentTask> | null;
};

/** 少于这个长度一律不判，避免「aa」也能换一把密钥。 */
export const MIN_INTENT_LENGTH = 6;

/** 谁在调用 → 码的第一段。 */
export const INTENT_ACTORS: IntentFacet[] = [
  { code: 'desktop-app', label: '桌面客户端', keywords: ['桌面', '客户端', 'cherry', 'chatbox', 'mac', 'windows'] },
  { code: 'web-app', label: '网页应用', keywords: ['网页', '网站', '前端页面', 'h5', 'web'] },
  { code: 'mobile-app', label: '移动应用', keywords: ['手机', '小程序', '移动端', 'ios', 'android'] },
  { code: 'backend-service', label: '后端服务', keywords: ['后端', '服务端', '微服务', 'backend', 'server'] },
  { code: 'agent', label: '智能体', keywords: ['智能体', '助手', '机器人', 'agent', 'bot', 'copilot'] },
  { code: 'automation', label: '自动化任务', keywords: ['脚本', '定时', '跑批', '批量', 'cron', '流水线'] },
  { code: 'internal-tool', label: '内部工具', keywords: ['内部工具', '管理后台', '运营后台', '工单系统'] },
];

/** 要做什么 → 码的第二段，同时决定调用类型。 */
export const INTENT_TASKS: IntentTask[] = [
  { code: 'customer-service', label: '客服问答', requestType: 'chat', keywords: ['客服', '售后', '咨询', '答疑'] },
  { code: 'knowledge-qa', label: '知识库问答', requestType: 'chat', keywords: ['知识库', '文档问答', '检索问答', 'rag'] },
  { code: 'summarize', label: '摘要总结', requestType: 'chat', keywords: ['摘要', '总结', '概括', '提炼', '纪要'] },
  { code: 'translate', label: '翻译', requestType: 'chat', keywords: ['翻译', '译文', '多语言', 'translate'] },
  { code: 'copywriting', label: '文案生成', requestType: 'chat', keywords: ['文案', '写作', '营销', '稿件'] },
  { code: 'code-assist', label: '代码辅助', requestType: 'chat', keywords: ['代码', '编程', '补全', '重构'] },
  { code: 'data-extract', label: '信息抽取', requestType: 'chat', keywords: ['抽取', '提取', '结构化', '字段解析'] },
  { code: 'classify', label: '分类打标', requestType: 'chat', keywords: ['分类', '打标', '标签', '意图识别'] },
  { code: 'moderation', label: '内容审核', requestType: 'chat', keywords: ['内容审核', '合规检查', '风控', '敏感词'] },
  { code: 'report', label: '报告生成', requestType: 'chat', keywords: ['报告', '周报', '日报', '汇报'] },
  { code: 'image-understand', label: '图片理解', requestType: 'vision', keywords: ['看图', '识图', '图片理解', '图像理解', '截图', '视觉'] },
  { code: 'image-ocr', label: '图片取字', requestType: 'vision', keywords: ['ocr', '文字识别', '票据', '发票', '证件'] },
  { code: 'image-audit', label: '图片审核', requestType: 'vision', keywords: ['图片审核', '图审', '违规图'] },
];

/**
 * 最长命中的关键词胜出，平局取表里靠前的。
 *
 * 不能用「表序优先」：那样「图片审核」会先撞上别的短词，判成文字类。
 * 取最长意味着判据不依赖表的排列顺序，加词条不会悄悄改变已有句子的判定。
 */
function matchFacet<T extends IntentFacet>(text: string, list: T[]): MatchedFacet<T> | null {
  let best: MatchedFacet<T> | null = null;
  for (const item of list) {
    for (const keyword of item.keywords) {
      if (!text.includes(keyword)) continue;
      if (!best || keyword.length > best.matched.length) best = { ...item, matched: keyword };
    }
  }
  return best;
}

export function analyzeAppCallerIntent(raw: string): IntentAnalysis {
  const text = raw.trim().toLowerCase();
  return {
    text,
    tooShort: text.length < MIN_INTENT_LENGTH,
    actor: matchFacet(text, INTENT_ACTORS),
    task: matchFacet(text, INTENT_TASKS),
  };
}

/** 拼出 appCallerCode。两段都在才拼，缺一段返回空串——不许兜底成占位值。 */
export function buildAppCallerCode(actorCode: string, taskCode: string, requestType: RequestType) {
  if (!actorCode || !taskCode) return '';
  return `${actorCode}.${taskCode}::${requestType}`;
}
