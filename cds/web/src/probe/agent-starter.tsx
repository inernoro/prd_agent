/*
 * 「接入 Agent」上手向导的布局探针挂载点（测试专用，不进 dist）。
 *
 * 只挂弹窗本身，不起路由、不打后端：向导用得到的技能清单在拉取失败时会
 * 退到内置兜底，足够撑起真实的卡片数量与底栏。判据见
 * scripts/agent-starter-mobile-probe.mjs。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../index.css'
import { SkillDownloadDialog } from '@/components/SkillDownloadDialog'

const projects = [{ id: 'probe-project', name: '探针项目', slug: 'probe', branchCount: 1 }]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SkillDownloadDialog open onOpenChange={() => {}} projects={projects} />
  </StrictMode>,
)
