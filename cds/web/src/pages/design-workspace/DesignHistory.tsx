import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DesignEntry, DesignVersion } from '../../../../src/shared/design-workspace';
import { currentDesignRun } from '../../../../src/shared/design-workspace';
import { designPublisherLabel, latestDesign, verdictNames } from './design-ui';

const recordTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const filters = [['all', '全部'], ['versions', '版本'], ['reviews', '评审和验收'], ['feedback', '反馈']] as const;
type Group = typeof filters[number][0];
type Event = { key: string; at: string; title: string; details: string; note?: string; open: () => void; label: string; group: Group };
type HistoryProps = {
  entry: DesignEntry; version: DesignVersion;
  onVersion: (version: number) => void; onRun: (version: number, run: string) => void; onFeedback: (feedbackId: string) => void;
};
const caption = (text: string) => {
  const sentence = text.trim().split(/(?<=[。！？])|\n/, 1)[0];
  return sentence.length > 48 ? sentence.slice(0, 47) + '…' : sentence;
};
const recent = <T extends { at: string }>(items: T[]) => items.sort((left, right) => right.at.localeCompare(left.at));

export function DesignHistory({ entry, version: viewing, onVersion, onRun, onFeedback }: HistoryProps) {
  const [params, setParams] = useSearchParams();
  const view = params.get('log') === 'timeline' ? 'timeline' : 'causal';
  const setView = (value: typeof view) => {
    const next = new URLSearchParams(params);
    if (value === 'timeline') next.set('log', value);
    else next.delete('log');
    setParams(next);
  };
  const [filter, setFilter] = useState<Group>('all');
  const latest = latestDesign(entry).version;
  const baseline = entry.versions.find(version => version.version === entry.frozen);
  const baselineRun = currentDesignRun(entry);
  const tags = (version: number) => [
    version === entry.frozen ? '实施基线' : '',
    version === entry.implementedVersion ? '已实现' : '',
    version === viewing.version ? '你在看' : '',
    version === latest ? '最新' : '',
  ].filter(Boolean);
  const feedback = entry.feedback ?? [];
  const rows = entry.versions.map(version => {
    const n = version.version;
    const open = () => onVersion(n);
    const publish: Event = { key: 'release', at: version.createdAt, title: version.note || '发布稿件',
      details: `${designPublisherLabel(version.publisher.label)} · ${version.sourceCommit.slice(0, 8)}`,
      open, label: '查看版本', group: 'versions' };
    const handled = feedback.flatMap(row => {
      const reply = row.replies.filter(item => item.revision === n).at(-1);
      return reply ? [{ row, reply }] : [];
    });
    const comments = entry.comments.filter(comment => Object.hasOwn(version.resolves, comment.id));
    const changedScreens = new Set([...handled.map(({ row }) => row.screenId), ...comments.map(comment => comment.screenId)].filter(Boolean));
    const pendingImplementation = (handled.length > 0 || comments.length > 0)
      && (entry.implementedVersion === undefined || n > entry.implementedVersion);
    const failedSameScreen = baseline?.acceptance.filter(rule => changedScreens.has(rule.screenId) &&
      baselineRun?.cells.some(cell => cell.itemId === rule.id && cell.status === 'failed')) ?? [];
    const related = feedback.filter(row => row.version === n);
    const effects: Event[] = recent([
      ...(entry.freezes ?? []).filter(item => item.version === n).map((row, index): Event => ({
        key: `freeze/${index}`, at: row.at, title: '定为实施基线', details: row.by, note: row.reason, open, label: '查看版本', group: 'reviews',
      })),
      ...(entry.unfreezes ?? []).filter(item => item.version === n).map((row, index): Event => ({
        key: `unfreeze/${index}`, at: row.at, title: '撤销定稿', details: row.by, open, label: '查看版本', group: 'reviews',
      })),
      ...entry.comments.flatMap(comment => comment.reviews.filter(item => item.version === n).map((review, index): Event => ({
        key: `${comment.id}/review/${index}`, at: review.at,
        title: review.decision === 'resolved' ? '确认评论已处理' : '退回评论', details: comment.body, note: review.body,
        open: () => onVersion(comment.version), label: '查看原版', group: 'reviews',
      }))),
      ...entry.runs.filter(run => run.version === n).flatMap(run => {
        const openRun = () => onRun(n, run.id);
        const failed = [...new Set(run.cells.filter(cell => cell.status === 'failed').map(cell => cell.itemId))];
        const details = `${run.target === 'installed' ? '主用构建' : `PR #${run.pullRequest}`} · ${run.commit.slice(0, 8)}`;
        const started: Event = { key: run.id, at: run.createdAt, title: `验收 · ${verdictNames[run.verdict]}`, details,
          ...(failed.length ? { note: `不通过 ${failed.join('、')}` } : {}), open: openRun, label: '查看证据', group: 'reviews' };
        return run.signed ? [started, { ...started, key: `signed/${run.id}`, at: run.signed.at,
          title: `签收 · ${verdictNames[run.signed.verdict]}`, label: '查看签收' }] : [started];
      }),
      ...related.flatMap(row => {
        const common = { details: row.title, open: () => onFeedback(row.id), label: '看反馈', group: 'feedback' as const };
        const opened: Event = { ...common, key: row.id, at: row.createdAt, title: '登记反馈' };
        return [opened, ...row.decisions.map((decision, index): Event => ({
          ...common, key: `${row.id}/${index}`, at: decision.at, title: decision.decision === 'close' ? '关闭反馈' : '重开反馈',
        }))];
      }),
    ]);
    const replies: Event[] = handled.map(({ row, reply }) => ({
      key: `${row.id}/reply`, at: reply.at, title: '回复反馈并关联版本', details: row.title,
      open: () => onFeedback(row.id), label: '看反馈', group: 'feedback',
    }));
    return { version, publish, handled, comments, pendingImplementation, failedSameScreen, effects, replies };
  }).reverse();
  const timeline = recent(rows.flatMap(row => [row.publish, ...row.effects, ...row.replies].map(event => ({ ...event, version: row.version.version }))))
    .filter(row => filter === 'all' || row.group === filter);
  return <section className="dw-history-v17" data-history-view={view}>
    <header className="dw-history-v17-head">
      <div><h2>稿件记录</h2><p className="dw-muted">发布、定稿、验收和反馈操作会自动记在这里。</p></div>
      <div className="dw-segments" role="group" aria-label="记录查看方式">
        <button type="button" data-action="history-causal" aria-pressed={view === 'causal'} onClick={() => setView('causal')}>按版本 · 因果</button>
        <button type="button" data-action="history-timeline" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>时间线</button>
      </div>
    </header>
    {view === 'causal' ? <div className="dw-history-chain">
      {rows.map(({ version, publish, handled, comments, pendingImplementation, failedSameScreen, effects }) => <article key={version.version} className="dw-surface dw-chain-card">
        <div className="dw-chain-head">
          <h3><span className="dw-history-version">V{version.version}</span> <strong title={publish.title}>{caption(publish.title)}</strong></h3>
          <div className="dw-chain-tags">{tags(version.version).map(tag => <span className="dw-history-tag" data-tag={tag} key={tag}>{tag}</span>)}</div>
          <time dateTime={publish.at}>{recordTime.format(new Date(publish.at))}</time>
          <button type="button" className="ep-link" onClick={publish.open}>查看版本</button>
        </div>
        <div className="dw-chain-body">
          <section><h4>因 · 这版处理了什么</h4>
            {handled.length || comments.length ? <ul>
              {handled.map(({ row }) => <li key={row.id}><button className="ep-link" type="button" onClick={() => onFeedback(row.id)}>{row.title}</button></li>)}
              {comments.map(comment => <li key={comment.id}><button className="ep-link" type="button"
                onClick={() => onVersion(comment.version)}>{caption(comment.body)}</button></li>)}
            </ul> : <p className="dw-muted">本版没有关联的反馈或评论处理声明。</p>}
          </section>
          <section><h4>果 · 发布后发生了什么</h4>
            {effects.length ? <ul>{effects.map(row => <li key={row.key}>
              <button className="ep-link" type="button" onClick={row.open}>{row.title}</button><span> {row.details}</span>
              {row.note && <p>{row.note}</p>}
            </li>)}</ul> : <p className="dw-muted">本版暂无定稿、验收或反馈记录。</p>}
          </section>
        </div>
        {pendingImplementation && <p className="dw-chain-pending">这版处理尚无实现签收记录。
          {entry.frozen !== undefined && ` 当前实施基线 V${entry.frozen}。`}
          {!!failedSameScreen.length && <> 同一画面在基线验收中不通过 {failedSameScreen.map(rule => rule.id).join('、')}。</>}
        </p>}
      </article>)}
    </div> : <section className="dw-surface dw-history-card">
      <div className="dw-row dw-history-heading"><h2>时间线</h2>
        <div className="dw-segments" role="group" aria-label="筛选记录">
          {filters.map(([key, label]) => <button key={key} type="button" aria-pressed={key === filter}
            onClick={() => setFilter(key)}>{label}</button>)}
        </div>
      </div>
      <ol className="dw-history-list">{timeline.map(row => <li key={`${row.version}/${row.key}`}>
        <strong className="dw-history-version">V{row.version}</strong>
        <div className="dw-history-content">
          <div className="dw-history-summary"><strong title={row.title}>{caption(row.title)}</strong>
            <time dateTime={row.at}>{recordTime.format(new Date(row.at))}</time></div>
          <small>{row.details}{row.group === 'versions' && tags(row.version).length ? ` · ${tags(row.version).join(' · ')}` : ''}</small>
          {row.title !== caption(row.title) && <details><summary>全文</summary><p>{row.title}</p></details>}
          {row.note && <p>{row.note}</p>}
        </div>
        <button type="button" className="ep-text-button" onClick={row.open}>{row.label}</button>
      </li>)}</ol>
      {!timeline.length && <p className="dw-muted">当前没有此类记录。</p>}
    </section>}
  </section>;
}
