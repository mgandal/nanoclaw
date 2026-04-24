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

    const event = makeEvent('security', 'Unrecognized login to recovery email');
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

// ─────────────────────────────────────────────────
// C12b: haystack hardening against prompt-indirect escalation
// ─────────────────────────────────────────────────
//
// The haystack is built from Ollama-derived topic + summary; Ollama's input
// included attacker-controlled email body. Three hardenings defend against
// a crafted email that smuggles multiple urgent keywords into the classified
// output to force dispatch at a target specialist:
//
// 1. Cap haystack length (prevents unbounded keyword planting surface).
// 2. Match on word boundaries, not substring (prevents compound-planted
//    "grantsnihvincent" from scoring three urgent hits).
// 3. Require a confidence floor for urgent escalation (low-confidence
//    Ollama classifications cannot drive specialist routing).

describe('C12b: haystack bounding and word-boundary matching', () => {
  it('keyword appearing only after haystack cap does not match', () => {
    // Build a summary > 500 chars where the keyword is at the very end.
    const filler = 'x '.repeat(300); // ~600 chars
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['preprint'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent('news', `${filler} preprint`);
    const target = routeClassifiedEvent(event, agents, groups);

    // Falls back to lead because 'preprint' is past the 500-char cap
    expect(target!.agentName).toBe('claire');
    expect(target!.reason).toMatch(/fallback/);
  });

  it('keyword appearing before the cap still matches', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['preprint'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent('news', 'preprint dropped from lab');
    const target = routeClassifiedEvent(event, agents, groups);

    expect(target!.agentName).toBe('einstein');
  });
});

describe('C12b: word-boundary keyword match', () => {
  it('substring-only hit does not score (grant should NOT match grants)', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['grant'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    // 'grants' (plural) — the old substring match would hit on 'grant'
    const event = makeEvent('updates', 'list of grants arrived');
    const target = routeClassifiedEvent(event, agents, groups);

    expect(target!.agentName).toBe('claire');
    expect(target!.reason).toMatch(/fallback/);
  });

  it('whole-word match still works (grant matches "NIH grant renewal")', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['grant'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent('funding', 'NIH grant renewal due');
    const target = routeClassifiedEvent(event, agents, groups);

    expect(target!.agentName).toBe('einstein');
  });

  it('compound keyword with hyphen still matches its hyphenated form', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('simon', {
        urgentTopics: ['pull-request'],
        groups: ['telegram_code-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:code', { folder: 'telegram_code-claw' }],
    ]);

    const event = makeEvent('ci', 'new pull-request opened');
    const target = routeClassifiedEvent(event, agents, groups);

    expect(target!.agentName).toBe('simon');
  });

  it('haystack with no separators cannot bleed multiple matches', () => {
    // Prior substring match: `haystack.includes('grant')` AND
    // `haystack.includes('nih')` both true for 'grantnihvincent',
    // giving +6 score with zero real signal. Word-boundary disarms this.
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['grant', 'nih'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent('noise', 'grantnihvincent');
    const target = routeClassifiedEvent(event, agents, groups);

    expect(target!.agentName).toBe('claire');
    expect(target!.reason).toMatch(/fallback/);
  });
});

describe('C12b: confidence floor gates urgent escalation', () => {
  it('low-confidence Ollama output cannot trigger urgent escalation', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['preprint'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent('news', 'preprint dropped');
    // Force low confidence — below URGENT_CONFIDENCE_FLOOR (0.6)
    event.classification.confidence = 0.3;

    const target = routeClassifiedEvent(event, agents, groups);

    // With confidence floor, urgent-match is downgraded — low-confidence
    // matches still score (preserving a signal), but not at urgent (+3)
    // priority. Here the only candidate agent is einstein with urgent:
    // 'preprint'. If urgent is downgraded to routine (+1), einstein
    // still wins because no other agent scores, but the reason field
    // should indicate downgrade and the score should not be >=3.
    expect(target!.agentName).toBe('einstein');
    expect(target!.score).toBeLessThan(3);
  });

  it('high-confidence urgent match still gets the +3 score', () => {
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['preprint'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent('news', 'preprint dropped');
    event.classification.confidence = 0.85;

    const target = routeClassifiedEvent(event, agents, groups);

    expect(target!.agentName).toBe('einstein');
    expect(target!.score).toBeGreaterThanOrEqual(3);
  });

  it('low-confidence + competing urgent matches: specialist does not beat lead on raw score alone', () => {
    // Specialist's urgent-match is downgraded to +1 (routine-equivalent).
    // Another agent with a high-confidence routine-matching keyword at +1
    // would now tie, so scoring ties go to the first-scored agent — what
    // we are protecting is that a low-confidence classification cannot
    // single-handedly escalate past a +1 baseline.
    const agents = [
      makeAgent('claire', { lead: true, groups: ['telegram_main'] }),
      makeAgent('einstein', {
        urgentTopics: ['preprint'],
        groups: ['telegram_science-claw'],
      }),
    ];
    const groups = makeGroups([
      ['tg:main', { folder: 'telegram_main', isMain: true }],
      ['tg:science', { folder: 'telegram_science-claw' }],
    ]);

    const event = makeEvent('news', 'preprint dropped');
    event.classification.confidence = 0.4;

    const target = routeClassifiedEvent(event, agents, groups);

    // Score is downgraded but still matches — so einstein wins with
    // score=1, NOT the pre-C12b score=3. Regression guard on +3.
    expect(target!.score).toBe(1);
  });
});
