/**
 * 任务台的下半屏：我们欠着什么。
 *
 * 上半屏和下半屏的差别是时态 —— 上面是「我现在要做什么」，下面是「我们欠着什么」。
 * 债务的正文写在仓库 doc/debt.*.md 里（那是它的 SSOT，跟代码同生共死），
 * 这里只补它在仓库里存不住的三样：**谁认领了、什么状态、转成了哪条任务**。
 *
 * 所以这一屏刻意不给正文编辑框：在这儿改了也存不住，下一次同步就被仓库覆盖回去。
 * 要改正文，去改那份 Markdown —— 界面上把文件路径亮出来，就是为了让人知道去哪改。
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { claimDebt, convertDebt, getDebtBoard, releaseDebt } from '@/services/real/activeTasks';
import type { DebtBoard, DebtItem } from '@/services/contracts/activeTasks';
import type { ApiResponse } from '@/types/api';

export interface DebtSectionProps {
  /** 转成任务之后让上半屏刷新 —— 那条活现在真的在队列里了 */
  onConverted: () => void;
}

export function DebtSection({ onConverted }: DebtSectionProps) {
  const [board, setBoard] = useState<DebtBoard | null>(null);
  const [open, setOpen] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getDebtBoard(mineOnly ? { mineOnly: true } : undefined);
    if (res.success && res.data) setBoard(res.data);
  }, [mineOnly]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (id: string, fn: () => Promise<ApiResponse<DebtItem>>, ok: string) => {
    setBusyId(id);
    const res = await fn();
    setBusyId(null);
    if (res.success) { toast.success(ok); await load(); }
    else toast.error(res.error?.message ?? '没成功');
  }, [load]);

  const onConvert = useCallback(async (d: DebtItem) => {
    setBusyId(d.id);
    const res = await convertDebt(d.id);
    setBusyId(null);
    if (res.success) {
      toast.success('进你的队列了');
      await load();
      onConverted();
    } else toast.error(res.error?.message ?? '没转成');
  }, [load, onConverted]);

  // 一条都没有就整块不出现 —— 没同步过的站点不该看见一个空壳分区。
  // 注意 total 是**整块看板**的数，不跟着「只看我的」走：跟着走的话，
  // 一条都没认领时这块会连同那个切回「看全部」的开关一起消失，用户走进去就出不来。
  if (!board || board.total === 0) return null;

  return (
    <div className="atb-group atb-debts">
      <div className="atb-group__head atb-debts__head">
        <button
          className="atb-debts__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="atb-debts__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          欠着的
          <span className="atb-debts__count">{board.total}</span>
        </button>
        <span className="atb-debts__headline">{board.headline}</span>
        {open && (
          <button
            className={`atb-link atb-link--quiet${mineOnly ? ' atb-link--on' : ''}`}
            onClick={() => setMineOnly((v) => !v)}
          >
            {mineOnly ? '看全部' : '只看我的'}
          </button>
        )}
      </div>

      {open && board.items.length === 0 && (
        <div className="atb-list" role="list">
          <div className="atb-row atb-debt-row atb-debt-row--empty" role="listitem">
            <div className="atb-row__body">
              <span className="atb-row__sub">
                你还没认领任何一条。整块还欠着 {board.total} 条，点上面的「看全部」。
              </span>
            </div>
          </div>
        </div>
      )}

      {open && board.items.length > 0 && (
        <div className="atb-list" role="list">
          {board.items.map((d) => (
            <div className="atb-row atb-debt-row" role="listitem" key={d.id}>
              <div className="atb-row__body">
                <button
                  className="atb-debt-row__title"
                  onClick={() => setExpanded((v) => (v === d.id ? null : d.id))}
                  aria-expanded={expanded === d.id}
                >
                  <span className="atb-debt-row__key">{d.key}</span>
                  {d.title}
                </button>
                <span className="atb-row__sub">
                  {d.ownerUserName
                    ? <span className="atb-tag">{d.mine ? '归我' : `${d.ownerUserName} 认领了`}</span>
                    : <span className="atb-tag">还没人管</span>}
                  {d.convertedTaskIds.length > 0 && (
                    <span className="atb-tag">已转成 {d.convertedTaskIds.length} 条活</span>
                  )}
                </span>

                {expanded === d.id && (
                  <div className="atb-debt-row__detail">
                    {d.status && <p><span className="atb-debt-row__label">现状</span>{d.status}</p>}
                    {d.closeCondition && <p><span className="atb-debt-row__label">补的条件</span>{d.closeCondition}</p>}
                    <p className="atb-debt-row__src">
                      正文在 <code>{d.sourcePath}</code> 第 {d.num} 条 —— 要改措辞去改那份文档，这里改了存不住
                    </p>
                  </div>
                )}
              </div>

              <div className="atb-rowact">
                <button
                  className="atb-link"
                  disabled={busyId === d.id}
                  onClick={() => void onConvert(d)}
                >
                  转成我的活
                </button>
                {d.mine
                  ? <button className="atb-link atb-link--quiet" disabled={busyId === d.id}
                      onClick={() => void act(d.id, () => releaseDebt(d.id), '放回去了')}>放回去</button>
                  : !d.ownerUserName && (
                    <button className="atb-link atb-link--quiet" disabled={busyId === d.id}
                      onClick={() => void act(d.id, () => claimDebt(d.id), '归你了')}>认领</button>
                  )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default DebtSection;
