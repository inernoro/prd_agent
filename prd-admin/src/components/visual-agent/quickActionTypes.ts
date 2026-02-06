import type { QuickActionConfig } from '@/services/contracts/userPreferences';

/** 快捷操作定义（内置 + DIY 通用） */
export type QuickAction = QuickActionConfig & {
  /** 是否为 DIY 自定义指令 */
  isDiy?: boolean;
};

/** 内置快捷操作列表 */
export const BUILTIN_QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'hd-upscale',
    name: 'HD 放大',
    icon: 'Maximize',
    prompt: 'Upscale this image to higher resolution with enhanced details, keep the same content and style',
  },
  {
    id: 'remove-bg',
    name: '移除背景',
    icon: 'Eraser',
    prompt: 'Remove the background of this image completely, keep only the main subject on a clean white background',
  },
  {
    id: 'mockup',
    name: 'Mockup',
    icon: 'Monitor',
    prompt: 'Place this design into a professional product mockup scene, make it look realistic',
  },
  {
    id: 'extend',
    name: '扩展',
    icon: 'Expand',
    prompt: 'Extend and outpaint this image, expanding the canvas boundaries while maintaining visual consistency with the original content',
  },
];

/** DIY 快捷指令上限 */
export const MAX_DIY_QUICK_ACTIONS = 10;
