import { describe, it, expect } from 'vitest';

import { routeClassifiedEvent } from './event-routing.js';
import type { AgentIdentity } from './agent-registry.js';
import type { ClassifiedEvent } from './event-router.js';
import type { RegisteredGroup } from './types.js';

const makeAgent = (
  dirName: string,
  opts: Partial<AgentIdentity> = {},
): AgentIdentity => ({
  name: dirName,
  role: 'test',
  description: 'test',
  dirName,
  dirPath: `/fake/${dirName}`,
  bodyMarkdown: '',
  ...opts,
});

const makeEvent = (
  topic: string,
  summary: string,
  routing: 'notify' | 'autonomous' | 'escalate' = 'escalate',
): ClassifiedEvent => ({
  event: {
    type: 'email',
    id: 'evt-1',
    timestamp: new Date().toISOString(),
    payload: { subject: summary },
  },
  classification: {
    importance: 0.9,
    urgency: 0.9,
    topic,
    summary,
    suggestedRouting: routing,
    requiresClaude: true,
    confidence: 0.8,
  },
  routing,
  classifiedAt: new Date().toISOString(),
  latencyMs: 10,
});

const makeGroups = (
  entries: Array<[string, { folder: string; isMain?: boolean }]>,
): Record<string, RegisteredGroup> => {
  const out: Record<string, RegisteredGroup> = {};
  for (const [jid, g] of entries) {
    out[jid] = {
      name: g.folder,
      folder: g.folder,
      trigger: '@Claire',
      added_at: new Date().toISOString(),
      isMain: g.isMain,
    };
  }
  return out;
};

describe('routeClassifiedEvent', () => {
  it('prefers agents whose urgent_topics match the event', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['paper', 'preprint'],
        groups: ['telegram_science-claw'],
      }),
      makeAgent('marvin', {
        urgentTopics: ['email', 'meeting'],
        groups: ['telegram_lab-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
      ['tg:lab', { folder: 'telegram_lab-claw' }],
    ]);

    const event = makeEvent(
      'paper-release',
      'A new preprint dropped from a competing lab',
    );
    const target = routeClassifiedEvent(event, agents, groups);

    expect(target).not.toBeNull();
    expect(target!.agentName).toBe('einstein');
    expect(target!.groupFolder).toBe('telegram_science-claw');
    expect(target!.chatJid).toBe('tg:science');
    expect(target!.score).toBeGreaterThanOrEqual(3);
  });

  it('falls back to lead agent when no topic matches', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['paper'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent(
      'security',
      'Unrecognized login to recovery email',
    );
    const target = routeClassifiedEvent(event, agents, groups);

    expect(target).not.toBeNull();
    expect(target!.agentName).toBe('claire');
    expect(target!.groupFolder).toBe('telegram_main');
    expect(target!.reason).toMatch(/fallback/);
  });

  it('urgent beats routine on scoring', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        routineTopics: ['paper'],
        groups: ['telegram_science-claw'],
      }),
      makeAgent('simon', {
        urgentTopics: ['paper'],
        groups: ['telegram_code-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
      ['tg:code', { folder: 'telegram_code-claw' }],
    ]);

    const event = makeEvent('paper', 'new paper');
    const target = routeClassifiedEvent(event, agents, groups);

    // simon (urgent:paper → +3) beats einstein (routine:paper → +1)
    expect(target!.agentName).toBe('simon');
  });

  it('returns null when no agents and no main group registered', () => {
    const target = routeClassifiedEvent(
      makeEvent('x', 'y'),
      [],
      makeGroups([]),
    );
    expect(target).toBeNull();
  });

  it('falls back to main group when agent has groups but none are registered', () => {
    const agents = [
      makeAgent('einstein', {
        urgentTopics: ['paper'],
        groups: ['telegram_science-claw'],
      }),
    ];
    // Note: telegram_science-claw is NOT registered.
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
    ]);
    const target = routeClassifiedEvent(
      makeEvent('paper', 'new paper'),
      agents,
      groups,
    );
    expect(target).not.toBeNull();
    expect(target!.agentName).toBe('einstein');
    expect(target!.groupFolder).toBe('telegram_main');
    expect(target!.reason).toMatch(/main fallback/);
  });

  it('picks first matching group when agent lists multiple', () => {
    const agents = [
      makeAgent('simon', {
        urgentTopics: ['code'],
        groups: ['telegram_code-claw', 'telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
      ['tg:code', { folder: 'telegram_code-claw' }],
    ]);
    const target = routeClassifiedEvent(
      makeEvent('code', 'release'),
      agents,
      groups,
    );
    expect(target!.groupFolder).toBe('telegram_code-claw');
  });

  it('case-insensitive topic match', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['Paper'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);
    const target = routeClassifiedEvent(
      makeEvent('PAPER', 'NEW PAPER'),
      agents,
      groups,
    );
    expect(target!.agentName).toBe('einstein');
  });
});
