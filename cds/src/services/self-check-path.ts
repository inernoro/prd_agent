/*
 * 自检端点的路径，单独一个文件：server.ts（公开路由白名单、API label）、index.ts
 * （挂路由、插端点）、前端（识别内置端点）都要认它，而它们不该互相 import。
 */
export const SELF_CHECK_PATH = '/api/self-check';
