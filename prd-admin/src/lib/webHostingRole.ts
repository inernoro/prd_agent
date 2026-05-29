import type { WebHostingRole } from '@/services/real/teams';

// 网页托管内容角色的前端展示 + 能力判定（与后端 WebHostingPermission 镜像）。
// 注册表模式：标签/选项集中维护，组件不内联硬编码。详见 .claude/rules/frontend-architecture.md。

export const WEB_HOSTING_ROLE_LABEL: Record<WebHostingRole, string> = {
  owner: '所有者',
  editor: '编辑者',
  viewer: '查看者',
};

export const WEB_HOSTING_ROLE_HINT: Record<WebHostingRole, string> = {
  owner: '可编辑、删除文件夹内任意站点、管理成员角色',
  editor: '可编辑 / 重传 / 建分享，不能删除别人的站点',
  viewer: '只读，不能编辑 / 删除 / 分享',
};

export const WEB_HOSTING_ROLE_OPTIONS: WebHostingRole[] = ['owner', 'editor', 'viewer'];

// 能力判定与后端 WebHostingPermission.Can 一致；站点创建者(isSiteOwner)在调用处单独短路放行。
export function canEditInWebHosting(role: WebHostingRole | null | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

export function canShareInWebHosting(role: WebHostingRole | null | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

export function canDeleteInWebHosting(role: WebHostingRole | null | undefined): boolean {
  return role === 'owner';
}
