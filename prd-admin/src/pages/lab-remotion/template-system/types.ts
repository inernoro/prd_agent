/**
 * 模板系统核心类型定义
 * 基于 Remotion 最佳实践：Zod Schema + Input Props
 */
import { z } from 'zod';
import React from 'react';

/**
 * 模板字段类型
 */
export type FieldType =
  | 'text'           // 单行文本
  | 'textarea'       // 多行文本
  | 'number'         // 数字
  | 'color'          // 颜色选择器
  | 'select'         // 下拉选择
  | 'image'          // 图片 URL
  | 'array'          // 数组（如演讲者列表）
  | 'boolean';       // 开关

/**
 * 字段元数据（用于生成 UI）
 */
export interface FieldMeta {
  label: string;           // 字段显示名称
  description?: string;    // 字段描述
  placeholder?: string;    // 占位符
  type: FieldType;         // 字段类型
  group?: string;          // 分组名称
  options?: { label: string; value: string }[];  // 下拉选项
  arrayItemSchema?: z.ZodObject<any>;  // 数组项的 Schema
  arrayItemFields?: Record<string, FieldMeta>;  // 数组项的字段定义
  min?: number;            // 最小值（数字）
  max?: number;            // 最大值（数字）
  step?: number;           // 步长（数字）
}

/**
 * 模板定义接口
 */
export interface TemplateDefinition<T extends z.ZodObject<any> = z.ZodObject<any>> {
  // 基本信息
  id: string;                    // 唯一标识
  name: string;                  // 模板名称
  description: string;           // 模板描述
  category: TemplateCategory;    // 分类
  thumbnail?: string;            // 缩略图 URL

  // Schema 定义
  schema: T;                     // Zod Schema
  defaultProps: z.infer<T>;      // 默认值
  fieldMeta: Record<string, FieldMeta>;  // 字段元数据

  // 组件
  component: React.FC<z.infer<T>>;  // Remotion 组件

  // 视频配置
  defaultDuration: number;       // 默认时长（秒）
  supportedAspectRatios: AspectRatio[];  // 支持的画面比例

  // AI 提示
  aiPromptHint: string;          // 给 AI 的提示，帮助理解这个模板的用途
  exampleUserInput: string;      // 示例用户输入
}

/**
 * 模板分类
 */
export type TemplateCategory =
  | 'conference'    // 会议/活动
  | 'product'       // 产品宣传
  | 'social'        // 社交媒体
  | 'data'          // 数据可视化
  | 'intro'         // 片头/片尾
  | 'celebration';  // 庆祝/纪念

/**
 * 画面比例
 */
export type AspectRatio = '16:9' | '9:16' | '1:1';

/**
 * 画面比例配置
 */
export const ASPECT_RATIO_CONFIG: Record<AspectRatio, { width: number; height: number; label: string }> = {
  '16:9': { width: 1920, height: 1080, label: '横屏 16:9' },
  '9:16': { width: 1080, height: 1920, label: '竖屏 9:16' },
  '1:1': { width: 1080, height: 1080, label: '方形 1:1' },
};

/**
 * 模板注册表类型
 */
export type TemplateRegistry = Record<string, TemplateDefinition>;

/**
 * AI 生成的参数结果
 */
export interface AIGeneratedProps<T = Record<string, unknown>> {
  templateId: string;
  props: T;
  confidence: number;  // 0-1，AI 对生成结果的信心度
  suggestions?: string[];  // AI 的额外建议
}
