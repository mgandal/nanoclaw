import { describe, expect, it } from 'vitest';

import { CalendarWatcher, type CalendarEvent } from './calendar-watcher.js';

describe('CalendarWatcher.detectConflicts', () => {
  it('detects overlapping events', () => {
    const events: CalendarEvent[] = [
      { title: 'Meeting A', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
      { title: 'Meeting B', start: '2026-03-26T10:30:00', end: '2026-03-26T11:30:00' },
    ];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].changeType).toBe('conflict');
    expect(conflicts[0].event.title).toBe('Meeting A');
    expect(conflicts[0].conflictsWith?.title).toBe('Meeting B');
  });

  it('does not flag back-to-back events', () => {
    const events: CalendarEvent[] = [
      { title: 'Meeting A', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
      { title: 'Meeting B', start: '2026-03-26T11:00:00', end: '2026-03-26T12:00:00' },
    ];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts).toHaveLength(0);
  });

  it('handles events with missing start/end without crashing', () => {
    const events = [
      { title: 'Good', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
      { title: 'Broken', start: '', end: '' },
      { title: 'Also broken' } as unknown as CalendarEvent,
    ] as CalendarEvent[];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts).toHaveLength(0);
  });

  it('handles empty array', () => {
    expect(CalendarWatcher.detectConflicts([])).toEqual([]);
  });

  it('handles single event', () => {
    const events: CalendarEvent[] = [
      { title: 'Solo', start: '2026-03-26T10:00:00', end: '2026-03-26T11:00:00' },
    ];
    expect(CalendarWatcher.detectConflicts(events)).toEqual([]);
  });
});
