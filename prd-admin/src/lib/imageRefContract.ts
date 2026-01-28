/**
 * 图片引用契约
 *
 * 统一三个输入链路的数据模型：
 * 1. 左侧画布选择 (selectedKeys)
 * 2. 右侧输入框 (RichComposer chipRefs)
 * 3. 首页带入 (initialPrompt inlineImage)
 *
 * @see doc/design.inline-image-chat.md
 */

/**
 * 画布中的图片项（来源数据）
 */
export interface CanvasImageItem {
  /** 画布内唯一标识 */
  key: string;
  /** 引用序号（1-based，显示给用户的 @img1, @img2...） */
  refId: number;
  /** 图片 URL */
  src: string;
  /** 用户给的标签/文件名 */
  label: string;
}

/**
 * 来自 RichComposer getStructuredContent() 的引用
 */
export interface ChipRef {
  canvasKey: string;
  refId: number;
}

/**
 * 统一的图片引用描述（解析后的标准格式）
 */
export interface ResolvedImageRef {
  /** 画布内唯一标识 */
  canvasKey: string;
  /** 引用序号 */
  refId: number;
  /** 图片 URL */
  src: string;
  /** 用户给的标签 */
  label: string;
  /** 来源类型 */
  source: 'chip' | 'selected' | 'inline' | 'text';
}

/**
 * 解析结果
 */
export interface ImageRefResolveResult {
  /** 是否成功（无 error 即为 true） */
  ok: boolean;
  /** 清理后的文本（移除旧格式标记） */
  cleanText: string;
  /** 解析出的图片引用列表（已去重，按优先级和出现顺序排列） */
  refs: ResolvedImageRef[];
  /** 警告信息（不影响发送，如：引用了不存在的 @img99） */
  warnings: string[];
  /** 错误信息（阻止发送，如：内容为空） */
  errors: string[];
}

/**
 * 统一入口的输入参数
 */
export interface ImageRefResolveInput {
  /** 用户输入的原始文本 */
  rawText: string;
  /** 来自 RichComposer 的 chip 引用（优先级最高） */
  chipRefs?: ChipRef[];
  /** 左侧画布选中的 keys */
  selectedKeys?: string[];
  /** 首页带入的内联图片（旧格式兼容） */
  inlineImage?: { src: string; name?: string };
  /** 当前画布中的所有图片（用于验证和补全） */
  canvas: CanvasImageItem[];
}

/**
 * 优先级说明：
 *
 * 1. chipRefs (RichComposer 中的 chip)
 *    - 用户明确在输入框中引用的图片
 *    - 按文本中出现的顺序
 *
 * 2. 文本中的 @imgN (regex 匹配)
 *    - 用于兼容纯文本输入或粘贴内容
 *    - 仅当 chipRefs 中没有对应引用时才补充
 *
 * 3. selectedKeys (左侧画布选择)
 *    - 用户在画布中选中但未引用的图片
 *    - 作为"上下文"补充
 *
 * 4. inlineImage (首页带入)
 *    - 旧格式兼容
 *    - 优先级最低，但会自动清理旧格式标记
 */

/**
 * 后端请求中的图片引用格式
 */
export interface ImageRefForRequest {
  /** 引用 ID（对应 @img1, @img2...） */
  refId: number;
  /** 图片 URL */
  url: string;
  /** 图片角色（可选，由 AI 推断或用户指定） */
  role?: 'target' | 'reference' | 'style' | 'background';
  /** 用户给的标签/描述 */
  label?: string;
  /** 图片中被选中的区域（未来 SAM 功能） */
  region?: ImageRegion;
}

/**
 * 图片区域选择（未来 SAM 功能预留）
 */
export interface ImageRegion {
  /** 点击位置（0-1 归一化坐标） */
  point?: { x: number; y: number };
  /** 分割掩码（base64 或 URL） */
  mask?: string;
  /** SAM 识别出的元素标签 */
  elementLabel?: string;
}
