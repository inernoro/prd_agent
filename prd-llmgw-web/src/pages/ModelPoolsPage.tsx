// 模型池：每个池一张卡，展示策略/类型/默认标记 + 池内每个模型的健康 chip。
// 「默认池」可就地切换（同类型互斥，写入共享 Mongo 后 MAP 调度立即改用该池）。
import { useEffect, useState } from 'react';
import { getPools, setPoolDefault } from '@/lib/api';
import type { ModelPool } from '@/lib/types';
import { Chip, SectionLoader, Button } from '@/components/ui';
import { healthChip } from '@/components/poolsHelpers';

const STRATEGY_LABEL: Record<number, string> = {
  0: '优先级', 1: '轮询', 2: '加权', 3: '最少连接', 4: '随机', 5: '故障转移',
};

export function ModelPoolsPage() {
  const [pools, setPools] = useState<ModelPool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getPools().then((res) => {
      if (!alive) return;
      if (res.success) setPools(res.data.items);
      else setError(res.error?.message || '加载失败');
    });
    return () => {
      alive = false;
    };
  }, []);

  async function makeDefault(pool: ModelPool) {
    if (pool.isDefaultForType) return;
    setBusyId(pool.id);
    setToast(null);
    const res = await setPoolDefault(pool.id, true);
    setBusyId(null);
    if (res.success) {
      // 同类型互斥：本池置默认，其它同 modelType 池清默认（前端同步反映后端行为）。
      setPools((prev) => (prev ? prev.map((x) => (x.modelType === res.data.modelType ? { ...x, isDefaultForType: x.id === res.data.id } : x)) : prev));
      setToast(`已将「${res.data.name}」设为 ${res.data.modelType || 'chat'} 类型的默认池`);
    } else {
      setToast(res.error?.message || '操作失败');
    }
  }

  if (error) return <Empty text={error} />;
  if (!pools) return <SectionLoader text="正在加载模型池…" />;
  if (pools.length === 0) return <Empty text="暂无模型池" />;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {toast ? (
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-secondary)', padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>{toast}</div>
      ) : null}
      {pools.map((p) => (
        <div
          key={p.id}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius)',
            padding: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{p.name}</span>
            <Chip label={p.modelType || 'chat'} color="var(--accent)" bg="var(--accent-soft)" />
            <Chip label={STRATEGY_LABEL[p.strategyType] || `策略${p.strategyType}`} color="var(--text-secondary)" bg="var(--bg-elevated)" />
            {p.isDefaultForType ? <Chip label="默认池" color="#3fb950" bg="rgba(63,185,80,0.14)" /> : null}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>优先级 {p.priority}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.models.length} 个模型</span>
              {p.isDefaultForType ? null : (
                <Button size="sm" variant="secondary" disabled={busyId === p.id} onClick={() => void makeDefault(p)}>
                  {busyId === p.id ? '处理中…' : '设为默认'}
                </Button>
              )}
            </span>
          </div>
          {p.description ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{p.description}</div>
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {p.models.map((m, i) => {
              const chip = healthChip(m.healthStatus);
              return (
                <div
                  key={`${m.modelId}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    padding: '8px 10px',
                    background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                  }}
                >
                  <Chip label={chip.label} color={chip.color} bg={chip.bg} title={`连续失败 ${m.consecutiveFailures} / 连续成功 ${m.consecutiveSuccesses}`} />
                  <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text-primary)' }}>{m.modelId}</span>
                  {m.protocol ? <span style={{ color: 'var(--text-muted)' }}>{m.protocol}</span> : null}
                  <span style={{ color: 'var(--text-muted)' }}>P{m.priority}</span>
                  {m.maxTokens ? <span style={{ color: 'var(--text-muted)' }}>maxTokens {m.maxTokens}</span> : null}
                  {m.consecutiveFailures > 0 ? (
                    <span style={{ color: '#f85149' }}>连败 {m.consecutiveFailures}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}
