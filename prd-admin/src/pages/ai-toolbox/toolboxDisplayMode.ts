export type ToolboxDisplayMode = 'compact' | 'standard' | 'showcase';

export const DEFAULT_TOOLBOX_DISPLAY_MODE: ToolboxDisplayMode = 'compact';

const TOOLBOX_DISPLAY_MODE_STORAGE_KEY = 'ai-toolbox.pref.displayMode';

export function normalizeToolboxDisplayMode(value: string | null): ToolboxDisplayMode {
  return value === 'compact' || value === 'standard' || value === 'showcase'
    ? value
    : DEFAULT_TOOLBOX_DISPLAY_MODE;
}

export function readToolboxDisplayMode(storage?: Pick<Storage, 'getItem'>): ToolboxDisplayMode {
  if (!storage) return DEFAULT_TOOLBOX_DISPLAY_MODE;

  try {
    return normalizeToolboxDisplayMode(storage.getItem(TOOLBOX_DISPLAY_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_TOOLBOX_DISPLAY_MODE;
  }
}

export function writeToolboxDisplayMode(
  storage: Pick<Storage, 'setItem'> | undefined,
  mode: ToolboxDisplayMode,
): void {
  if (!storage) return;

  try {
    storage.setItem(TOOLBOX_DISPLAY_MODE_STORAGE_KEY, mode);
  } catch {
    // 隐私模式或存储已满时只影响偏好记忆，当前页面状态仍然有效。
  }
}
