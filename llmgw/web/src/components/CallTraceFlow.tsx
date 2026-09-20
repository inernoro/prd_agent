// 判定流程图：架构文档第 3 节那张静态图，按这个模型此刻的状态点亮。
//
// 为什么面板里要再画一遍：静态图谁都能画，它回答的是「这套东西设计成什么样」。
// 人站在某个模型面前想知道的是另一件事——**这一刻，这条链路在我这个模型上走的是哪一支**。
// 那份心安来自「拐走的地方我也看得见」，而不是一条被抹平的直线。
//
// 每条岔路的状态全部由后端下发（CallTracePlanner 与运行时由行为对照钉死）。
// 这个组件一句判断都不做：画出来的图最容易被人当真，它错了比列表错了更糟。
import type { CallTraceFlowNode } from '@/lib/types';
import { BODY_TEXT, HINT_TEXT } from '@/lib/typography';
import { GAP, INSET_BLOCK } from '@/lib/surface';

/** 三档状态各自的样式与标签。possible 不是「没走」——是「取决于请求或调用方」。 */
const STATE_STYLE = {
  taken: { label: '走这支', color: 'var(--ok)', bg: 'var(--ok-bg)', border: 'var(--accent)', opacity: 1 },
  possible: { label: '可能走', color: 'var(--text-secondary)', bg: 'var(--bg-elevated)', border: 'var(--border-subtle)', opacity: 1 },
  blocked: { label: '走不到', color: 'var(--text-muted)', bg: 'var(--bg-elevated)', border: 'var(--border-subtle)', opacity: 0.55 },
} as const;

export function CallTraceFlow({ nodes }: { nodes: CallTraceFlowNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div data-testid="call-trace-flow" style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
      {nodes.map((node, index) => (
        <div key={node.id} data-testid={`call-trace-flow-${node.id}`} style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
          {node.question ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.tight }}>
              <span aria-hidden style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-caption)' }}>◇</span>
              <span style={{ ...BODY_TEXT, fontWeight: 'var(--fw-strong)' as unknown as number }}>{node.question}</span>
            </div>
          ) : null}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: GAP.tight,
            paddingLeft: node.question ? GAP.section : 0,
            borderLeft: node.question ? '1px solid var(--border-subtle)' : undefined,
            marginLeft: node.question ? GAP.tight : 0,
          }}>
            {node.branches.map((branch) => {
              const style = STATE_STYLE[branch.state] ?? STATE_STYLE.possible;
              return (
                <div key={`${node.id}-${branch.label}`} style={{
                  ...INSET_BLOCK,
                  display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap',
                  border: `1px solid ${style.border}`,
                  opacity: style.opacity,
                }}>
                  <span style={{
                    ...HINT_TEXT, fontSize: 'var(--fs-caption)', color: style.color,
                    width: 58, flexShrink: 0,
                  }}>{style.label}</span>
                  <span style={{ ...BODY_TEXT, minWidth: 140 }}>{branch.label}</span>
                  <span aria-hidden style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)' }}>→</span>
                  <span style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)', flex: 1, minWidth: 200 }}>{branch.outcome}</span>
                  {branch.note ? (
                    <span style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>{branch.note}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {index < nodes.length - 1 ? (
            <span aria-hidden style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)', paddingLeft: GAP.tight }}>↓</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
