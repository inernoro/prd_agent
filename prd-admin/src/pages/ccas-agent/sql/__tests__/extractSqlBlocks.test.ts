import { describe, expect, it } from 'vitest';
import { __test__ } from '../CcasSqlAiAssistant';

const { extractSqlBlocks } = __test__;

describe('extractSqlBlocks', () => {
  it('extracts single ```sql block', () => {
    const md = '前言\n\n```sql\nSELECT * FROM t\n```\n\n说明';
    expect(extractSqlBlocks(md)).toBe('SELECT * FROM t');
  });

  it('joins multiple sql blocks with blank line', () => {
    const md = '```sql\nSELECT 1\n```\n中间\n```sql\nUPDATE t SET a=1\n```';
    expect(extractSqlBlocks(md)).toBe('SELECT 1\n\nUPDATE t SET a=1');
  });

  it('accepts case-insensitive and tsql/mysql language tags', () => {
    const md = '```SQL\nA\n```\n```tsql\nB\n```\n```mysql\nC\n```';
    expect(extractSqlBlocks(md)).toBe('A\n\nB\n\nC');
  });

  it('falls back to full text when no fenced sql block present', () => {
    const md = 'just text';
    expect(extractSqlBlocks(md)).toBe('just text');
  });

  it('returns empty string for empty input', () => {
    expect(extractSqlBlocks('')).toBe('');
  });

  it('ignores empty fenced blocks', () => {
    const md = '```sql\n```\n```sql\nSELECT 1\n```';
    expect(extractSqlBlocks(md)).toBe('SELECT 1');
  });
});
