import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Copy, Coins } from 'lucide-react';
import {
  compact,
  WorkspaceEmpty,
  WorkspaceLink,
  WorkspaceMetric,
  WorkspacePanel,
  WorkspaceSearch,
} from '@/components/workspace/Workspace';
import { copyToClipboard } from '@/lib/clipboard';
import type { ExecutiveModelStat } from '@/services/contracts/executive';
import {
  duration,
  money,
  percent,
  priceCoverage,
} from './executiveOperationsModel';

const VIEWS = [
  { key: 'usage', label: '用量分布' },
  { key: 'pricing', label: '价格覆盖' },
  { key: 'detail', label: '费用明细' },
] as const;
type View = (typeof VIEWS)[number]['key'];
const modelName = (model: ExecutiveModelStat) => model.model || '未记录模型';
export function ExecutiveCostWorkspace({
  models,
}: {
  models?: ExecutiveModelStat[];
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [copyState, setCopyState] = useState('');
  const view: View =
    VIEWS.find((item) => item.key === params.get('costView'))?.key ?? 'usage';
  const coverage = useMemo(() => priceCoverage(models ?? []), [models]);
  const filtered = useMemo(
    () =>
      (models ?? []).filter(
        (item) =>
          modelName(item).toLowerCase().includes(query.toLowerCase()) &&
          (filter === 'all' ||
            (filter === 'unpriced' ? !item.hasPricing : item.hasPricing)),
      ),
    [models, query, filter],
  );
  const byTokens = useMemo(
    () =>
      [...filtered].sort(
        (a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls,
      ),
    [filtered],
  );
  const tableRows = [...filtered].sort((a, b) =>
    view === 'pricing'
      ? Number(a.hasPricing) - Number(b.hasPricing) || b.calls - a.calls
      : b.calls - a.calls,
  );
  const rows = view === 'usage' ? byTokens.slice(0, 8) : tableRows;
  const selected = params.has('model') ? params.get('model') : null;
  const model = filtered.find((item) => item.model === selected) ?? byTokens[0];
  const maxTokens = Math.max(
    1,
    ...rows.map((item) => item.inputTokens + item.outputTokens),
  );
  function setView(next: View) {
    setParams(
      (previous) => {
        const p = new URLSearchParams(previous);
        p.set('tab', 'cost');
        p.set('costView', next);
        return p;
      },
      { replace: true },
    );
  }
  function select(key: string) {
    setParams(
      (previous) => {
        const p = new URLSearchParams(previous);
        p.set('tab', 'cost');
        p.set('model', key);
        return p;
      },
      { replace: true },
    );
  }
  async function copyMissing() {
    const names = coverage.missing
      .filter((item) => item.model.trim())
      .map((item) => item.model);
    const success = await copyToClipboard(names.join('\n'));
    setCopyState(
      success
        ? `已复制 ${names.length} 个未定价模型名称`
        : '复制失败，请手动选取模型名称',
    );
  }
  return (
    <div className="map-workspace op-workspace" data-workspace="cost">
      <div className="ws-toolbar">
        <WorkspaceSearch
          value={query}
          onChange={setQuery}
          placeholder="搜索模型"
        />
        <div className="ws-tabs">
          {[
            { key: 'all', label: '全部' },
            { key: 'unpriced', label: '缺失定价' },
            { key: 'priced', label: '已定价' },
          ].map((item) => (
            <button
              key={item.key}
              aria-pressed={filter === item.key}
              onClick={() => {
                setFilter(item.key);
                if (item.key === 'unpriced') setView('pricing');
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ws-metrics">
        <WorkspaceMetric
          label="已定价预估成本"
          value={
            models
              ? coverage.cost === undefined
                ? models.length
                  ? '暂不可估算'
                  : '暂无模型'
                : money(coverage.cost)
              : null
          }
          note={
            models
              ? `${coverage.priced.length}/${models.length} 个模型已定价`
              : '等待价格覆盖资料'
          }
        />
        <WorkspaceMetric
          label="模型调用"
          value={models ? compact(coverage.calls) : null}
        />
        <WorkspaceMetric
          label="总 Token"
          value={models ? compact(coverage.tokens) : null}
        />
        <WorkspaceMetric
          label="缺失定价模型"
          value={models ? coverage.missing.length : null}
          tone={coverage.missing.length ? 'warning' : undefined}
        />
      </div>
      {coverage.missing.length > 0 && (
        <p className="ws-alert">
          {coverage.missing.length}{' '}
          个模型未配置价格，其调用不能当作零成本，也未包含在已定价预估成本中。
        </p>
      )}
      <div className="op-mode-toolbar">
        <div className="ws-tabs" aria-label="成本分析视图">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              aria-pressed={view === item.key}
              onClick={() => setView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <small>汇总为当前统计窗口；搜索与价格筛选作用于下方模型</small>
      </div>
      <div className="ws-layout op-cost-layout">
        <div className="ws-main">
          {view === 'pricing' && (
            <WorkspacePanel
              title="调用价格覆盖"
              hint="按调用次数衡量价格覆盖，不推算未计价费用"
            >
              <div className="op-coverage-head">
                <div>
                  <strong>
                    {models
                      ? coverage.coverage === undefined
                        ? '无调用'
                        : percent(coverage.pricedCalls, coverage.calls)
                      : '—'}
                  </strong>
                  <span>调用已覆盖价格</span>
                </div>
                <div>
                  <b>{models ? compact(coverage.pricedCalls) : '—'}</b>
                  <small>已覆盖调用</small>
                </div>
                <div>
                  <b>{models ? compact(coverage.missingCalls) : '—'}</b>
                  <small>未计价调用</small>
                </div>
              </div>
              {models && coverage.calls > 0 ? (
                <div
                  className="op-price-track"
                  role="img"
                  aria-label={`已覆盖 ${coverage.pricedCalls} 次，未计价 ${coverage.missingCalls} 次`}
                >
                  <i style={{ width: `${(coverage.coverage ?? 0) * 100}%` }} />
                </div>
              ) : (
                <p className="op-scope-note">
                  {models ? '本窗口没有调用记录' : '价格资料读取中'}
                </p>
              )}
              <p className="op-scope-note">
                未计价部分只统计调用与用量，不作为零元加入费用。价格来源以统计服务当前已配置单价为准。
              </p>
            </WorkspacePanel>
          )}
          <WorkspacePanel
            title={
              view === 'usage'
                ? '模型 Token 排名'
                : view === 'pricing'
                  ? '模型定价覆盖'
                  : '模型费用明细'
            }
            hint={
              view === 'usage'
                ? '按 Token 降序 · 前 8 项 · 占比以当前窗口全部已记录 Token 为分母'
                : view === 'pricing'
                  ? '缺失定价优先，按调用量排列；空模型名称需要先补齐调用标识'
                  : '按调用量排列；预估金额不是供应商账单'
            }
            action={
              view === 'usage' ? (
                <WorkspaceLink onClick={() => setView('detail')}>
                  查看全部模型
                </WorkspaceLink>
              ) : (
                <span className="op-scope-note">
                  {models ? filtered.length : '—'} 项
                </span>
              )
            }
          >
            {models && rows.length > 0 ? (
              <div className="ws-table-wrap">
                <table className="ws-table op-model-table">
                  <thead>
                    <tr>
                      <th>模型</th>
                      {view === 'usage' ? (
                        <>
                          <th>输入 / 输出 Token</th>
                          <th>总 Token</th>
                          <th>占窗口 Token</th>
                          <th>价格状态</th>
                        </>
                      ) : (
                        <>
                          <th>调用</th>
                          <th>输入 / 输出 Token</th>
                          <th>平均响应</th>
                          <th>预估成本</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((item) => (
                      <tr
                        key={item.model}
                        aria-selected={item === model}
                        onClick={() => select(item.model)}
                      >
                        <td>
                          <button className="ws-row-action">
                            <strong>{modelName(item)}</strong>
                          </button>
                        </td>
                        {view === 'usage' ? (
                          <>
                            <td>
                              <div className="scene-track token">
                                <i
                                  style={{
                                    width: `${(item.inputTokens / maxTokens) * 100}%`,
                                  }}
                                />
                                <i
                                  style={{
                                    width: `${(item.outputTokens / maxTokens) * 100}%`,
                                  }}
                                />
                              </div>
                              <small>
                                {compact(item.inputTokens)} /{' '}
                                {compact(item.outputTokens)}
                              </small>
                            </td>
                            <td className="number">
                              {compact(item.totalTokens)}
                            </td>
                            <td>
                              {percent(item.totalTokens, coverage.tokens)}
                            </td>
                            <td>
                              <span
                                className={`ws-badge ${item.hasPricing ? 'good' : 'warning'}`}
                              >
                                {item.hasPricing ? '可估算' : '不可估算'}
                              </span>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="number">{compact(item.calls)}</td>
                            <td>
                              <small>
                                {compact(item.inputTokens)} /{' '}
                                {compact(item.outputTokens)}
                              </small>
                            </td>
                            <td>{duration(item.avgDurationMs)}</td>
                            <td>
                              {item.hasPricing ? (
                                money(item.totalCost)
                              ) : (
                                <span className="ws-badge warning">
                                  不可估算
                                </span>
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <WorkspaceEmpty
                title={models ? '本筛选下暂无模型' : '模型统计读取中'}
              />
            )}
          </WorkspacePanel>
          {view === 'usage' && (
            <button
              className="op-detail-entry"
              onClick={() => setView('detail')}
            >
              <Coins size={17} />
              <strong>费用明细</strong>
              <span>查看每个模型的调用、Token 与可估算费用</span>
              <span>打开明细</span>
            </button>
          )}
        </div>
        <aside className="ws-side">
          <WorkspacePanel title="价格覆盖" hint="当前窗口全部模型">
            <div className="op-price-summary">
              <strong>
                {models ? coverage.priced.length : '—'}
                <small> / {models?.length ?? '—'}</small>
              </strong>
              <span>模型已定价</span>
            </div>
            <dl className="ws-facts">
              <dt>未计价调用</dt>
              <dd>{models ? compact(coverage.missingCalls) : '—'}</dd>
              <dt>缺少模型名称</dt>
              <dd>
                {models
                  ? coverage.missing.filter((item) => !item.model.trim()).length
                  : '—'}{' '}
                组
              </dd>
            </dl>
            <WorkspaceLink
              onClick={() => {
                setFilter('unpriced');
                setView('pricing');
              }}
            >
              查看价格覆盖
            </WorkspaceLink>
            <button
              className="op-copy-button"
              disabled={!coverage.missing.some((item) => item.model.trim())}
              onClick={() => void copyMissing()}
            >
              <Copy size={13} />
              复制待定价模型清单
            </button>
            {copyState && (
              <p role="status" className="op-scope-note">
                {copyState}
              </p>
            )}
          </WorkspacePanel>
          <WorkspacePanel
            title={model ? `模型详情 · ${modelName(model)}` : '选择模型'}
          >
            {model ? (
              <>
                <span
                  className={`ws-badge ${model.hasPricing ? 'good' : 'warning'}`}
                >
                  {model.hasPricing ? '已定价预估' : '缺失定价'}
                </span>
                <dl className="ws-facts op-inspector-facts">
                  <dt>输入 Token</dt>
                  <dd>{compact(model.inputTokens)}</dd>
                  <dt>输出 Token</dt>
                  <dd>{compact(model.outputTokens)}</dd>
                  <dt>总 Token</dt>
                  <dd>{compact(model.totalTokens)}</dd>
                  <dt>生图数量</dt>
                  <dd>{model.imageCount}</dd>
                  <dt>Token 成本</dt>
                  <dd>{model.hasPricing ? money(model.tokenCost) : '—'}</dd>
                  <dt>调用成本</dt>
                  <dd>{model.hasPricing ? money(model.callCost) : '—'}</dd>
                  <dt>总预估</dt>
                  <dd>{model.hasPricing ? money(model.totalCost) : '—'}</dd>
                </dl>
                {model.model.trim() ? (
                  <WorkspaceLink
                    permission="logs.read"
                    onClick={() =>
                      navigate(
                        `/logs?tab=llm&model=${encodeURIComponent(model.model)}`,
                      )
                    }
                  >
                    查看该模型调用
                  </WorkspaceLink>
                ) : (
                  <p className="ws-note">
                    这些请求未记录模型名称，不能按模型准确筛选。
                  </p>
                )}
              </>
            ) : (
              <WorkspaceEmpty title="暂无可选模型" />
            )}
          </WorkspacePanel>
          <p className="op-scope-note">
            显式零价格保留为零；没有价格时显示不可估算。复制清单只用于核对模型名称，不会修改价格配置。
          </p>
        </aside>
      </div>
    </div>
  );
}
