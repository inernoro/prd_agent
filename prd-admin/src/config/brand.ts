/**
 * 品牌配置
 * 从环境变量读取，编译后成为静态字符串
 */

/** 应用全名，如 "米多智能体平台（MAP）" */
export const APP_NAME = import.meta.env.VITE_APP_NAME || '米多智能体平台（MAP）';

/** 应用简称，如 "MAP" */
export const APP_NAME_SHORT = import.meta.env.VITE_APP_NAME_SHORT || 'MAP';

/** 后台标题，如 "MAP Admin" */
export const ADMIN_TITLE = import.meta.env.VITE_ADMIN_TITLE || 'MAP Admin';
