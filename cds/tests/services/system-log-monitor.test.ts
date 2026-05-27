import { afterEach, describe, expect, it } from 'vitest';
import {
  journalPriorityArgs,
  parseJournalLine,
  shouldRecordJournalMessage,
} from '../../src/services/system-log-monitor.js';

describe('SystemLogMonitor safeguards', () => {
  const originalPriority = process.env.CDS_JOURNAL_PRIORITY;

  afterEach(() => {
    if (originalPriority == null) delete process.env.CDS_JOURNAL_PRIORITY;
    else process.env.CDS_JOURNAL_PRIORITY = originalPriority;
  });

  it('does not record successful proxy access lines as server events', () => {
    expect(
      shouldRecordJournalMessage(
        'info',
        '[proxy] GET /readyz -> http://127.0.0.1:10715 (branch=a, profile=default)',
      ),
    ).toBe(false);
    expect(
      shouldRecordJournalMessage(
        'info',
        '[proxy] POST /api/documents -> http://127.0.0.1:10715 (branch=a, profile=default)',
      ),
    ).toBe(false);
  });

  it('keeps warning and error journal lines', () => {
    expect(shouldRecordJournalMessage('warn', '[proxy] upstream error: ECONNRESET')).toBe(true);
    expect(shouldRecordJournalMessage('error', 'Main process exited, code=killed')).toBe(true);
  });

  it('tails warning and error journal priorities by default', () => {
    delete process.env.CDS_JOURNAL_PRIORITY;
    expect(journalPriorityArgs()).toEqual(['-p', 'warning..alert']);
  });

  it('allows explicit all-priority journal collection for diagnostics', () => {
    process.env.CDS_JOURNAL_PRIORITY = 'all';
    expect(journalPriorityArgs()).toEqual([]);
  });

  it('parses malformed journal lines as plain messages without throwing', () => {
    expect(parseJournalLine('not json')).toEqual({ MESSAGE: 'not json' });
  });
});
