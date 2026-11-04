import type { CanvasImageItem } from './visualAgentCanvasPersist';

// 只提供既有画布类型的系统默认文案，不据此识别或迁移用户已保存的内容。
export const CANVAS_SHAPE_LABEL_MAP = {
  rect: '矩形',
  circle: '圆形',
  triangle: '三角形',
  star: '星形',
} as const satisfies Record<NonNullable<CanvasImageItem['shapeType']>, string>;

export const CANVAS_GENERATOR_LABEL = '图像生成器';
export const CANVAS_TEXT_LABEL = '文字';
