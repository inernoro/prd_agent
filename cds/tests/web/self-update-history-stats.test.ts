import { describe, expect, it } from 'vitest';
import { summariseHistory } from '../../web/src/pages/cds-settings/tabs/MaintenanceTab.js';
const records = (values: Array<number | undefined>) => values.map((durationMs, index) => ({ ts: `2026-11-15T00:00:${String(index).padStart(2, '0')}Z`, branch: 'fixture', fromSha: '1111111', toSha: '2222222', trigger: 'manual' as const, status: 'success' as const, durationMs }));
describe('自更新历史真实耗时统计', () => {
  it('无耗时样本不制造零值', () => { const stats = summariseHistory([]); expect(stats).toMatchObject({total:0,avgMs:null,medianMs:null,p95Ms:null,fastestMs:null}); });
  it('单个样本可核算且保留显式零耗时', () => { expect(summariseHistory(records([1200]))).toMatchObject({avgMs:1200,medianMs:1200,p95Ms:1200}); expect(summariseHistory(records([0,undefined]))).toMatchObject({medianMs:0,p95Ms:0,fastestMs:0}); });
  it('两个样本中位取均值，P95沿用服务端最近秩法，不低于中位', () => { expect(summariseHistory(records([45000,20000]))).toMatchObject({avgMs:32500,medianMs:32500,p95Ms:45000,fastestMs:20000}); });
  it('大量可核算样本与次序无关', () => { const stats = summariseHistory(records(Array.from({length:100},(_,index)=>100-index))); expect(stats).toMatchObject({total:100,medianMs:50.5,p95Ms:95,fastestMs:1}); });
});
