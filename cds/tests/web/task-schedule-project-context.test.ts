import { describe, expect, it } from 'vitest';
import {
  resolveTaskScheduleProjectId,
  taskScheduleProjectReference,
} from '../../web/src/lib/task-schedule-project.js';

describe('task schedule project context', () => {
  const projects = [
    { id: 'proj-a', slug: 'alpha' },
    { id: 'proj-b', slug: 'beta' },
  ];

  it('selects the explicit project carried by an Agent mission URL', () => {
    expect(taskScheduleProjectReference('?project=proj-b')).toBe('proj-b');
    expect(resolveTaskScheduleProjectId('?project=proj-b', projects)).toBe('proj-b');
    expect(resolveTaskScheduleProjectId('?project=beta', projects)).toBe('proj-b');
  });

  it('falls back to the first available project when the query is absent or invalid', () => {
    expect(resolveTaskScheduleProjectId('', projects)).toBe('proj-a');
    expect(resolveTaskScheduleProjectId('?project=missing', projects)).toBe('proj-a');
    expect(resolveTaskScheduleProjectId('?project=missing', [])).toBe('');
  });
});
