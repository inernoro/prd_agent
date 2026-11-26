import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { DesignMethodId } from '../../../../src/shared/design-methods';

type Guide = { who: string; when: string; steps: [string, string, string]; standard: string; examples: [string, string, string] };

export const methodGuides: Record<DesignMethodId, Guide> = {
  mece: { who: '智能体，评审人复核', when: '开始验收时',
    steps: ['按六个维度列出实际风险。', '用 risk-matrix 将风险关联到能验证它的规则。', '没有适用风险的维度写清理由。'],
    standard: '每个维度都已核对，所有适用风险均对应可执行的验收项。',
    examples: ['正确性 · 输入检查漏了空值', 'A-18 验证输入为空时保留查询条件', '运维部署 · 此处没有独立部署，沿用平台部署验收'] },
  compare: { who: '智能体，评审人复核', when: '实现预览可用后',
    steps: ['确认画面的进入状态、数据规模、视口和主题。', '用 design-replication 实拍，并排对照稿件。', '逐处解释叠加差异，记录 V-01 结论。'],
    standard: '每个声明的画面和主题均有同条件双图与有效的对照结论。',
    examples: ['成员列表 · 1280 × 800 · 浅色 · 展开状态', '稿件与实拍各 12 条结果，操作行均展开', '标题对齐，邀请按钮实拍比稿件低 4 px → 有问题'] },
  visual: { who: '智能体，评审人复核', when: '实拍完成后',
    steps: ['用 create-visual-test-to-kb 按视口和主题实拍。', '完成 V-01 到 V-10，写数值或具体可见现象。', '证据注明画面、检查对象和差异。'],
    standard: '十项检查在各适用画面上均有具体证据并通过。',
    examples: ['深色列表 · 检查 V-02 对齐', '添加按钮 y=150，导入按钮 y=154', '两按钮顶边相差 4 px，超出 1 px → 有问题'] },
  regress: { who: '智能体，评审人复核', when: '每次验收',
    steps: ['登记有实际来源的缺陷，记录适用画面。', '用可重复的检查方法重新验证。', '把本次结果写到原编号下。'],
    standard: '所有适用的历史易错项在本次均复查通过。',
    examples: ['K-01 · 列表分页按钮错位 · 缺陷 3 次', '测量上一页和下一页按钮顶边，误差 ≤ 1 px', '1280 × 800，两按钮 y=612 → 通过'] },
  flow: { who: '智能体，评审人复核', when: '功能实现后',
    steps: ['用 acceptance-scenario-orchestrator 确定角色与任务。', '按顺序执行并留下每一步的预期与实际。', '遇到阻断时写清停在哪一步，复验后补证据。'],
    standard: '所有已启用流程的每一步都有实际结果且均通过。',
    examples: ['管理员 · 从成员列表打开移除确认', '预期显示接手人及恢复期；实际缺少恢复期', '第 2 步有问题，保留完整路径与失败证据'] },
  human: { who: '评审人', when: '签收前',
    steps: ['用 acceptance-checklist 写清操作、预期和失败处理。', '按适用视口逐项操作并回填实际证据。', '用关联反馈或债务记录未通过原因。'],
    standard: '每个适用场景均有评审人、执行时间、证据和通过结论。',
    examples: ['在列表打开一位演示成员的移除确认', '预期说明接手人及 7 天恢复期', '提示和危险操作区完整，截图核对后标通过'] },
  smoke: { who: '自动化', when: '每次部署后',
    steps: ['用 smoke-test 列出关键页面和接口。', '在已匹配提交的预览上执行，记录返回及耗时。', '保留失败原始响应，修完后重跑。'],
    standard: '关键页面和接口均可用，异常均能回溯到执行证据。',
    examples: ['GET /api/example-members → 预期 HTTP 200', '实际 HTTP 200，用时 86ms，返回 12 项', '接着检查列表渲染出同样 12 项 → 通过'] },
  debt: { who: '智能体', when: '检查证据缺口时',
    steps: ['用 acceptance-debt-loop 找出暂时无法验证的声明。', '补充可复验的检查，仍有缺口就记账。', '关联正式债务和本次验收项。'],
    standard: '每个保留缺口都有原因、补救办法及可追溯的债务记录。',
    examples: ['A-18 · 搜索应在 300ms 内完成', '当前缺少从操作到结果的耗时记录', '登记测量补救办法、责任人和期限'] },
};

export function MethodDemo({ id, name, close }: { id: DesignMethodId; name: string; close: () => void }) {
  const [step, setStep] = useState(0);
  const guide = methodGuides[id];
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="dw-modal dw-surface dw-demo">
    <DialogTitle>看示例 · {name}</DialogTitle>
    <DialogDescription>下面是演示数据，用来说明怎样执行和记录这一项。</DialogDescription>
    <ol className="dw-demo-steps" aria-label="示例步骤">{guide.steps.map((_, index) => <li key={index}>
      <button type="button" aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}>{`第 ${index + 1} 步`}</button>
    </li>)}</ol>
    <div className="dw-demo-body" aria-live="polite"><p>{guide.steps[step]}</p><pre>{guide.examples[step]}</pre></div>
    <footer><button className="ep-button" type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>上一步</button>
      <button className="ep-button ep-button--primary" type="button"
        onClick={() => step < guide.steps.length - 1 ? setStep(step + 1) : close()}>{step < guide.steps.length - 1 ? '下一步' : '看完了'}</button>
    </footer>
  </DialogContent></Dialog>;
}
