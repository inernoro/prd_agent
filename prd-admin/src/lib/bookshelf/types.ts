/**
 * 公共藏书阁 —— 类型定义
 *
 * 这里是「书目 + 心路阶段 + 考题」的类型契约。内容本身是策展的静态资产
 * （非 UGC、非后端业务数据），按 frontend-architecture.md「数据源统一维护在
 * src/lib/ 下」落在本目录，走注册表模式，禁止在组件里散写 switch。
 */

/** 读者角色。both = 开发者与产品经理都该读。 */
export type Track = 'dev' | 'pm' | 'both';

/** 阅读门槛：1 入门可直接读 / 2 有一年工程经验再读 / 3 啃硬骨头。 */
export type Level = 1 | 2 | 3;

export interface BookEntry {
  id: string;
  /** 中文书名（不带书名号，渲染时补） */
  title: string;
  /** 原版书名，没有中译或原名更知名时填 */
  original?: string;
  author: string;
  track: Track;
  level: Level;
  /** 为什么在这一卷 —— 必须对准该卷要治的痛点，不写「经典必读」这种空话 */
  why: string;
  /** 读完你能做什么 —— 一句可执行的动作，不是感受 */
  takeaway: string;
}

export interface Volume {
  id: string;
  /** 卷序，从 1 开始 */
  index: number;
  /** 卷名，如「开机」 */
  name: string;
  /** 副标题：这一卷讲什么 */
  subtitle: string;
  /** lucide-react 图标名 */
  icon: string;
  /** 这一卷对应的真实抱怨（来自团队原话），让读者一眼认出「这说的就是我」 */
  painQuote: string;
  /** 这一卷开的药方：读完之后那句抱怨为什么不再成立 */
  cure: string;
  books: BookEntry[];
}

/** 单选题。考的是判断力，不是背书名。 */
export interface ExamQuestion {
  id: string;
  /** 所属卷 id */
  volumeId: string;
  stem: string;
  options: string[];
  /** 正确选项下标 */
  answer: number;
  /** 解析：为什么这个对、其它为什么错 */
  explain: string;
}

/** 痛点药方：把一句抱怨映射到能治它的那一卷。 */
export interface PainRemedy {
  /** 团队里真实说过的那句话 */
  quote: string;
  /** 病根一句话 */
  diagnosis: string;
  /** 去哪一卷 */
  volumeId: string;
}
