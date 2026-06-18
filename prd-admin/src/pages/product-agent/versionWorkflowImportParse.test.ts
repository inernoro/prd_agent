import { describe, expect, it } from 'vitest';
import {
  parseVersionWorkflowImportCsv,
} from './versionWorkflowImportParse';

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

  it('skips blank header row after real header (语雀上线导出)', () => {
    const csv = [
      '系统,应用,正式版本号,内部版本号,项目类别,版本类别,产品立项方案名称,所属部门,产品负责人,上线时间,合同签订方,当前开放品牌,备注',
      ',,,,,,,,,,,,',
      '大数据引擎系统,互动营销,V3.5.2,T3.5.2,定制项目,小版本,互动营销V3.5.2（大转盘升级）,品牌域产品部,苟于华,2021-09-01,消时乐,上线全域开放,',
      '大数据引擎系统,互动营销,-,-,非定制项目,临时优化需求,临时优化小报,品牌域产品部,何丹铃,2021-09-15,,,',
    ].join('\n');
    const rows = parseVersionWorkflowImportCsv(csv, 'release');
    expect(rows).toHaveLength(2);
    expect(rows[0].code).toBe('V3.5.2');
    expect(rows[0].tCode).toBe('T3.5.2');
    expect(rows[0].appName).toBe('互动营销');
    expect(rows[0].legacyData?.['产品']).toBe('互动营销');
    expect(rows[0].planName).toBe('互动营销V3.5.2（大转盘升级）');
    expect(rows[0].projectType).toBe('custom');
    expect(rows[0].legacyData?.['合同签订方']).toBe('消时乐');
    expect(rows[0].date).toBeTruthy();
    expect(rows[1].code).toBeUndefined();
    expect(rows[1].planName).toBe('临时优化小报');
    expect(rows[1].projectType).toBe('standard');
  });

  it('maps 非定制项目 as standard not custom', () => {
    const csv = [
      '立项号,产品立项方案名称,项目类别',
      'T1.0.0,测试方案,非定制项目',
    ].join('\n');
    const rows = parseVersionWorkflowImportCsv(csv, 'initiation');
    expect(rows[0].projectType).toBe('standard');
  });

  it('parses yuque initiation date header with line break', () => {
    const csv = [
      '系统,应用,项目类别,立项号,版本类别,产品立项方案名称,项目需求描述,所属部门,产品负责人,第一稿会议时间,第二稿会议时间,第三稿会议时间,立项时间（三稿通过）,是否需要UI设计,方案地址,开发状态',
      '大数据引擎系统,互动营销,非定制项目,T3.6.1,小版本,互动营销T3.6.1（红包）,发放企业付款红包,品牌域产品部,何丹铃,2021-09-01,2021-09-02,2021-09-03,2021-09-03,是,,已上线',
    ].join('\n');
    const rows = parseVersionWorkflowImportCsv(csv, 'initiation');
    expect(rows[0].code).toBe('T3.6.1');
    expect(rows[0].appName).toBe('互动营销');
    expect(rows[0].ownerId).toBe('何丹铃');
    expect(rows[0].projectAt).toBeTruthy();
    expect(rows[0].needUiDesign).toBe(true);
  });
});
