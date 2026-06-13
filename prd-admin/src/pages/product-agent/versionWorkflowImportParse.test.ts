import { describe, expect, it } from 'vitest';
import { parseVersionWorkflowImportCsv } from './versionWorkflowImportParse';

describe('versionWorkflowImportParse', () => {
  it('parses release rows with V code and plan name', () => {
    const csv = [
      '正式版本号,内部版本号,产品立项方案名称,版本类别,上线日期',
      'V6.1.0,T6.1.0,会员积分优化,小版本,2024-06-01',
    ].join('\n');
    const rows = parseVersionWorkflowImportCsv(csv, 'release');
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('V6.1.0');
    expect(rows[0].tCode).toBe('T6.1.0');
    expect(rows[0].planName).toBe('会员积分优化');
    expect(rows[0].versionType).toBe('小版本');
  });

  it('parses initiation rows with T code', () => {
    const csv = [
      'T立项号,产品立项方案名称,所属部门,开发状态',
      'T6.2.1,渠道返利方案,产品部,已完成',
    ].join('\n');
    const rows = parseVersionWorkflowImportCsv(csv, 'initiation');
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('T6.2.1');
    expect(rows[0].planName).toBe('渠道返利方案');
    expect(rows[0].departmentName).toBe('产品部');
    expect(rows[0].developmentStatus).toBe('已完成');
  });
});
