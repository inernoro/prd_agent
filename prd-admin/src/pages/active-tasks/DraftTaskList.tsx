/**
 * AI 拆出来的候选任务列表 —— 一键导入和吸取建议共用这一份。
 *
 * 两处都是同一件事：模型流式吐出一条条候选，人逐条勾、可以改标题，确认了才入库。
 * 抄两份必然漂移（本仓库 predicate-and-wiring-discipline 形状 3），所以只留这一个。
 *
 * 等待期不给转圈：条目一条条冒出来，那就是产物本身在长（artifact-is-experience）。
 */
import type { DraftTask } from '@/services/contracts/activeTasks';

export interface DraftRow extends DraftTask {
  /** 前端自己发的行号，模型不保证给 id */
  key: string;
  picked: boolean;
}

export interface DraftTaskListProps {
  rows: DraftRow[];
  onToggle: (key: string) => void;
  onRename: (key: string, title: string) => void;
  /** 还在流式吐的时候给一行骨架，别让人以为没了 */
  streaming?: boolean;
}

function dueText(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function DraftTaskList({ rows, onToggle, onRename, streaming }: DraftTaskListProps) {
  return (
    <div className="atb-list" role="list">
      {rows.map((r) => (
        <div className={`atb-row atb-draft${r.picked ? '' : ' atb-draft--off'}`} role="listitem" key={r.key}>
          <button
            className={`atb-check-circle${r.picked ? ' atb-check-circle--on' : ''}`}
            aria-label={r.picked ? `不要这条：${r.title}` : `要这条：${r.title}`}
            aria-pressed={r.picked}
            onClick={() => onToggle(r.key)}
          >
            {r.picked && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            )}
          </button>
          <div className="atb-row__body">
            <input
              className="atb-inline-input"
              value={r.title}
              aria-label="任务标题"
              onChange={(e) => onRename(r.key, e.target.value)}
            />
            {(r.from || r.why) && (
              <span className="atb-row__sub">
                {r.from && <span className="atb-tag">{r.from} 提的</span>}
                {r.why}
              </span>
            )}
          </div>
          {r.dueAt && <span className="atb-due">{dueText(r.dueAt)}</span>}
        </div>
      ))}

      {streaming && (
        <div className="atb-row atb-draft" aria-hidden="true">
          <span className="atb-check-circle atb-check-circle--ghost" />
          <div className="atb-row__body"><span className="atb-skeleton" /></div>
        </div>
      )}
    </div>
  );
}

export default DraftTaskList;
