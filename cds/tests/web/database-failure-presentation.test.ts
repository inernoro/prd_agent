import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { databaseFailure } from '../../web/src/lib/databaseFailure.js';
import { DatabaseExecutionNotice } from '../../web/src/components/branch/DatabaseExecutionNotice.js';

describe('database failure presentation', () => {
  it.each(["Table 'private.secret' doesn't exist", 'relation "private.secret" does not exist'])(
    'explains missing tables without leaking raw query or request URL: %s', (reason) => {
      const failure = databaseFailure({ status: 500, body: { error: reason }, message: 'POST /_cds/api/private token=SECRET', requestId: 'req_123' }, 'sql');
      expect(failure.summary).toBe('找不到 SQL 中指定的表。');
      const html = renderToStaticMarkup(createElement(DatabaseExecutionNotice, { failure, batchWrite: true, showDiagnostics: true }));
      expect(html).toContain('请核对左侧库表列表');
      expect(html).toContain('此前已提交的修改可能仍然生效');
      expect(html).toContain('勿直接重复整批执行');
      expect(html).not.toMatch(/private|SECRET|POST|does not exist/);
      expect(html).toContain('<details');
      expect(html).not.toContain('<details open');
      expect(html).toContain('req_123');
    },
  );
  it('keeps safe diagnostics out of member UI and warns on uncertain timeout', () => {
    const failure = databaseFailure({ status: 504, body: { error: 'query timeout password=SECRET' }, requestId: 'req_safe' }, 'sql');
    expect(failure.recovery).toContain('不要直接重复提交');
    const html = renderToStaticMarkup(createElement(DatabaseExecutionNotice, { failure }));
    expect(html).not.toMatch(/SECRET|504|req_safe|诊断信息/);
    expect(databaseFailure({ requestId: '<script>', message: 'secret' }, 'sql').diagnostic).toBeUndefined();
  });
  it('explains rejected Mongo empty-filter deletes and unknown failures without rendering exception text', () => {
    const failure = databaseFailure({ status: 400, body: { error: 'deleteMany 必须提供非空 filter' } }, 'mongo');
    expect(failure.summary).toContain('删除已阻止');
    expect(failure.recovery).toContain('限定要删除的记录');
    const unknown = databaseFailure(new Error('mongodb://root:SECRET@private'), 'mongo');
    expect(unknown.summary).toBe('数据库操作未完成。');
    expect(unknown.recovery).not.toContain('诊断编号');
  });
  it.each([401, 403, 400])('gives an actionable explanation for status %s', status => {
    const failure = databaseFailure({ status, message: 'raw-error-secret' }, 'sql');
    expect(failure.summary).not.toContain('raw-error');
    expect(failure.recovery.length).toBeGreaterThan(12);
  });
  it('keeps Mongo write feedback outside the scrollable form and before results', () => {
    const source = readFileSync(new URL('../../web/src/components/BranchDetailDrawer.tsx', import.meta.url), 'utf8');
    const mongo = source.slice(source.indexOf('function MongoResourceDataPanel('), source.indexOf('function MongoStructuredWritePanel('));
    expect(mongo).toContain('lg:grid-rows-[15.3125rem_auto_minmax(0,1fr)]');
    const slot = mongo.indexOf('data-testid="mongo-write-feedback"');
    expect(slot).toBeGreaterThan(mongo.indexOf('</section>'));
    expect(slot).toBeLessThan(mongo.indexOf('<MongoDocumentsView'));
    const form = source.slice(source.indexOf('function MongoStructuredWritePanel('), source.indexOf('function MongoDocumentsView('));
    expect(form).not.toContain('{state.message}');
  });
});
