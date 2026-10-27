import { describe, expect, it } from 'vitest';
import {
  parseVersionWorkflowImportCsv,
  parseVersionWorkflowImportMatrix,
} from './versionWorkflowImportParse';

describe('versionWorkflowImportParse', () => {
  it('识别实表E1空表头的唯一T列，保留T号及应用并跳过短横占位', () => {
    const rows = parseVersionWorkflowImportMatrix([
      ['平台', '系统', '应用', '项目类别', '', '版本类别', '产品立项方案名称'],
      ['米多平台', '大数据引擎系统', '互动营销', '非定制项目', 'T3.6.1', '小版本', '互动营销T3.6.1（方案甲）'],
      ['米多平台', '大数据引擎系统', '智能营销', '定制项目', 'T2.8.4', '小版本', '智能营销T2.8.4（方案乙）'],
      ['米多平台', '大数据引擎系统', '互动营销', '非定制项目', '--', '小版本', '未编号方案'],
    ], 'initiation');
    expect(rows.map((row) => row.code)).toEqual(['T3.6.1', 'T2.8.4', undefined]);
    expect(rows.map((row) => row.appName)).toEqual(['互动营销', '智能营销', '互动营销']);
    expect(rows[0].planName).toBe('互动营销T3.6.1（方案甲）');
  });

  it('显式编号列优先于空表头列及方案名称，不用名称覆盖真实编号', () => {
    const rows = parseVersionWorkflowImportMatrix([
      ['应用', '', '立项号', '产品立项方案名称'],
      ['互动营销', 'T8.8.8', 'T3.6.1', '互动营销T4.4.4（方案）'],
    ], 'initiation');
    expect(rows[0].code).toBe('T3.6.1');
  });

  it('无编号列只提取名称中唯一完整T号，多个编号及占位不猜号', () => {
    const rows = parseVersionWorkflowImportMatrix([
      ['应用', '', '产品立项方案名称'],
      ['互动营销', '2026-10-16', '互动营销T3.6.1（方案）'],
      ['互动营销', '', '互动营销R=TXXXX（待定方案）'],
      ['互动营销', '', 'T1.2.3与T1.2.4合并方案'],
      ['互动营销', '', 'T1.2.3.4不是标准T号'],
    ], 'initiation');
    expect(rows.map((row) => row.code)).toEqual(['T3.6.1', undefined, undefined, undefined]);
  });

  it('两个无表头T列无法唯一判断时明确阻止，不静默选第一列', () => {
    expect(() => parseVersionWorkflowImportMatrix([
      ['应用', '', '', '产品立项方案名称'],
      ['互动营销', 'T3.6.1', 'T4.0.0', '方案'],
    ], 'initiation')).toThrow('多个没有表头的 T 号列');
  });

  it('正式版本导入不套用无表头T推断或方案名T提取', () => {
    const rows = parseVersionWorkflowImportMatrix([
      ['应用', '', '正式版本号', '产品立项方案名称'],
      ['互动营销', 'T3.6.1', 'V3.6.1', '互动营销T3.6.1（方案）'],
    ], 'release');
    expect(rows[0].code).toBe('V3.6.1');
    expect(rows[0].tCode).toBeUndefined();
  });
  it('ignores training columns in internal history, including dates and arbitrary placeholders', () => {
    for (const value of ['2026.10.16', '待确认', '-1', '1.5', '30']) {
      const rows = parseVersionWorkflowImportMatrix([
        ['应用', 'T 立项号', '产品立项方案名称', '预计培训时间', '立项时间'],
        ['互动营销', 'T3.47.1', '渠道返利优化', value, '2026-10-16'],
      ], 'initiation');
      expect(rows).toHaveLength(1);
      expect(rows[0].code).toBe('T3.47.1');
      expect(rows[0].appName).toBe('互动营销');
      expect(rows[0].projectAt).toBeDefined();
      expect(rows[0].plannedTrainingMinutes).toBeUndefined();
    }
  });

  it('does not treat a blank Excel header as a training or other business column', () => {
    const rows = parseVersionWorkflowImportMatrix([
      ['', '应用', 'T 立项号', '产品立项方案名称', '立项时间'],
      ['2026-10-16', '互动营销', 'T3.47.1', '渠道返利优化', '2026-10-15'],
    ], 'initiation');
    expect(rows[0].appName).toBe('互动营销');
    expect(rows[0].code).toBe('T3.47.1');
    expect(rows[0].planName).toBe('渠道返利优化');
    expect(rows[0].plannedTrainingMinutes).toBeUndefined();
    expect(rows[0].ownerName).toBeUndefined();
    expect(rows[0].remark).toBeUndefined();
  });

  it('keeps release minute validation while ignoring unrelated blank columns', () => {
    const rows = parseVersionWorkflowImportMatrix([
      ['', '应用', '正式版本号', '产品立项方案名称', '预计培训时长（分钟）'],
      ['2026-10-16', '互动营销', 'V3.47.1', '渠道返利优化', '30'],
    ], 'release');
    expect(rows[0].plannedTrainingMinutes).toBe(30);
    expect(rows[0].appName).toBe('互动营销');
  });

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

  it('reads AI POC and global-open fields used by the version registration archive', () => {
    const csv = [
      '正式版本号,内部版本号,产品立项方案名称,是否属于AI POC项目,是否全域开放',
      'V2.3.4,T3.4.5,版本登记联动,是,否',
    ].join('\n');
    const rows = parseVersionWorkflowImportCsv(csv, 'release');
    expect(rows[0].isAiPoc).toBe(true);
    expect(rows[0].openBrandScope).toBe('否');
    expect(rows[0].isGlobalOpen).toBe(false);
  });

  it('preserves rollout fields and reads training as minutes', () => {
    const csv = [
      '应用,正式版本号,产品立项方案名称,需求来源,产品负责人,项目组成员,合同签订方,预计培训时长（分钟）',
      '互动营销,V2.3.5,上线方案,拜耳,宇凡,宇凡、火巍,客户甲,30',
    ].join('\n');
    const rows = parseVersionWorkflowImportCsv(csv, 'release');
    expect(rows[0].demandSource).toBe('拜耳');
    expect(rows[0].ownerName).toBe('宇凡');
    expect(rows[0].projectMemberNames).toEqual(['宇凡', '火巍']);
    expect(rows[0].contractParty).toBe('客户甲');
    expect(rows[0].plannedTrainingMinutes).toBe(30);
  });

  it('rejects dates and fractions instead of guessing duration', () => {
    for (const value of ['2026.09.20 14:30', '1.5', '-1']) {
      expect(() => parseVersionWorkflowImportCsv(`应用,正式版本号,产品立项方案名称,预计培训时长\n互动营销,V2.3.5,上线方案,${value}`, 'release')).toThrow('预计培训时长');
    }
    expect(parseVersionWorkflowImportCsv('正式版本号,产品立项方案名称,预计培训时长\nV2.3.5,方案,0 分钟', 'release')[0].plannedTrainingMinutes).toBe(0);
  });
});
