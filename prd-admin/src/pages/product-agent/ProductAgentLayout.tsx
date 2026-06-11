/**
 * 产品管理智能体 — 共享左侧导航布局（管理层总览 / 单产品视图 两级复用）。
 *
 * 实现已抽取为跨智能体共享组件 components/agent-shell/AgentFullscreenLayout，
 * 此处保留原导出名以兼容既有 import。
 */
export { AgentFullscreenLayout as ProductAgentLayout, SectionShell, type NavItem } from '@/components/agent-shell/AgentFullscreenLayout';
