import { describe, it, expect } from 'vitest';
import path from 'path';

import {
  ASSISTANT_NAME,
  ASSISTANT_HAS_OWN_NUMBER,
  OLLAMA_ADMIN_TOOLS,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  MAX_MESSAGES_PER_PROMPT,
  MOUNT_ALLOWLIST_PATH,
  SENDER_ALLOWLIST_PATH,
  STORE_DIR,
  GROUPS_DIR,
  DATA_DIR,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CREDENTIAL_PROXY_PORT,
  IPC_POLL_INTERVAL,
  IDLE_TIMEOUT,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  MAX_CONCURRENT_CONTAINERS,
  buildTriggerPattern,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  TRIGGER_PATTERN,
  TIMEZONE,
  TELEGRAM_BOT_POOL,
  CONTEXT_PACKET_MAX_SIZE,
  HEALTH_MONITOR_INTERVAL,
  MAX_CONTAINER_SPAWNS_PER_HOUR,
  MAX_ERRORS_PER_HOUR,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  OLLAMA_TIMEOUT,
  EVENT_ROUTER_ENABLED,
  GMAIL_POLL_INTERVAL,
  GMAIL_CREDENTIALS_PATH,
  CALENDAR_WATCHER_ENABLED,
  CALENDAR_POLL_INTERVAL,
  CALENDAR_NAMES,
  CALENDAR_LOOKAHEAD_DAYS,
  TRUST_MATRIX_PATH,
} from './config.js';

// --- Exported constants: types and reasonable values ---

describe('config exports: types and defaults', () => {
  it('ASSISTANT_NAME is a non-empty string', () => {
    expect(typeof ASSISTANT_NAME).toBe('string');
    expect(ASSISTANT_NAME.length).toBeGreaterThan(0);
  });

  it('boolean flags are actual booleans', () => {
    expect(typeof ASSISTANT_HAS_OWN_NUMBER).toBe('boolean');
    expect(typeof OLLAMA_ADMIN_TOOLS).toBe('boolean');
    expect(typeof EVENT_ROUTER_ENABLED).toBe('boolean');
    expect(typeof CALENDAR_WATCHER_ENABLED).toBe('boolean');
  });

  it('CONTAINER_IMAGE is a non-empty string', () => {
    expect(typeof CONTAINER_IMAGE).toBe('string');
    expect(CONTAINER_IMAGE.length).toBeGreaterThan(0);
  });

  it('TELEGRAM_BOT_POOL is an array (possibly empty)', () => {
    expect(Array.isArray(TELEGRAM_BOT_POOL)).toBe(true);
  });

  it('CALENDAR_NAMES is a non-empty array of strings', () => {
    expect(Array.isArray(CALENDAR_NAMES)).toBe(true);
    expect(CALENDAR_NAMES.length).toBeGreaterThan(0);
    for (const name of CALENDAR_NAMES) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

// --- Path configuration ---

describe('config paths', () => {
  it('all directory paths are absolute', () => {
    expect(path.isAbsolute(STORE_DIR)).toBe(true);
    expect(path.isAbsolute(GROUPS_DIR)).toBe(true);
    expect(path.isAbsolute(DATA_DIR)).toBe(true);
  });

  it('directory paths have no trailing slashes', () => {
    expect(STORE_DIR).not.toMatch(/\/$/);
    expect(GROUPS_DIR).not.toMatch(/\/$/);
    expect(DATA_DIR).not.toMatch(/\/$/);
  });

  it('MOUNT_ALLOWLIST_PATH is absolute and under ~/.config/nanoclaw/', () => {
    expect(path.isAbsolute(MOUNT_ALLOWLIST_PATH)).toBe(true);
    expect(MOUNT_ALLOWLIST_PATH).toContain('.config/nanoclaw/');
    expect(MOUNT_ALLOWLIST_PATH).toMatch(/mount-allowlist\.json$/);
  });

  it('SENDER_ALLOWLIST_PATH is absolute and under ~/.config/nanoclaw/', () => {
    expect(path.isAbsolute(SENDER_ALLOWLIST_PATH)).toBe(true);
    expect(SENDER_ALLOWLIST_PATH).toContain('.config/nanoclaw/');
    expect(SENDER_ALLOWLIST_PATH).toMatch(/sender-allowlist\.json$/);
  });

  it('TRUST_MATRIX_PATH is inside DATA_DIR', () => {
    expect(TRUST_MATRIX_PATH.startsWith(DATA_DIR)).toBe(true);
    expect(TRUST_MATRIX_PATH).toMatch(/trust\.yaml$/);
  });

  it('GMAIL_CREDENTIALS_PATH is absolute', () => {
    expect(path.isAbsolute(GMAIL_CREDENTIALS_PATH)).toBe(true);
  });
});

// --- Timeout / interval values: sane ranges ---

describe('config timeouts and intervals', () => {
  it('POLL_INTERVAL is positive and under 1 minute', () => {
    expect(POLL_INTERVAL).toBeGreaterThan(0);
    expect(POLL_INTERVAL).toBeLessThanOrEqual(60_000);
  });

  it('SCHEDULER_POLL_INTERVAL is positive and at least 10s', () => {
    expect(SCHEDULER_POLL_INTERVAL).toBeGreaterThanOrEqual(10_000);
    expect(SCHEDULER_POLL_INTERVAL).toBeLessThanOrEqual(600_000);
  });

  it('IPC_POLL_INTERVAL is positive and under 1 minute', () => {
    expect(IPC_POLL_INTERVAL).toBeGreaterThan(0);
    expect(IPC_POLL_INTERVAL).toBeLessThanOrEqual(60_000);
  });

  it('CONTAINER_TIMEOUT is positive and at least 1 minute', () => {
    expect(CONTAINER_TIMEOUT).toBeGreaterThanOrEqual(60_000);
    // Not absurdly large (under 24 hours)
    expect(CONTAINER_TIMEOUT).toBeLessThanOrEqual(86_400_000);
  });

  it('IDLE_TIMEOUT is positive and at least 1 minute', () => {
    expect(IDLE_TIMEOUT).toBeGreaterThanOrEqual(60_000);
    expect(IDLE_TIMEOUT).toBeLessThanOrEqual(86_400_000);
  });

  it('HEALTH_MONITOR_INTERVAL is positive', () => {
    expect(HEALTH_MONITOR_INTERVAL).toBeGreaterThan(0);
  });

  it('OLLAMA_TIMEOUT is positive and under 5 minutes', () => {
    expect(OLLAMA_TIMEOUT).toBeGreaterThan(0);
    expect(OLLAMA_TIMEOUT).toBeLessThanOrEqual(300_000);
  });

  it('GMAIL_POLL_INTERVAL is at least 10s', () => {
    expect(GMAIL_POLL_INTERVAL).toBeGreaterThanOrEqual(10_000);
  });

  it('CALENDAR_POLL_INTERVAL is at least 10s', () => {
    expect(CALENDAR_POLL_INTERVAL).toBeGreaterThanOrEqual(10_000);
  });
});

// --- Container limits ---

describe('container limits', () => {
  it('CONTAINER_MAX_OUTPUT_SIZE is at least 1MB', () => {
    expect(CONTAINER_MAX_OUTPUT_SIZE).toBeGreaterThanOrEqual(1_048_576);
  });

  it('CONTAINER_MAX_OUTPUT_SIZE default is 10MB', () => {
    // Default when no env override
    expect(CONTAINER_MAX_OUTPUT_SIZE).toBe(10_485_760);
  });

  it('MAX_CONCURRENT_CONTAINERS is at least 1', () => {
    expect(MAX_CONCURRENT_CONTAINERS).toBeGreaterThanOrEqual(1);
  });

  it('MAX_MESSAGES_PER_PROMPT is positive and reasonable', () => {
    expect(MAX_MESSAGES_PER_PROMPT).toBeGreaterThan(0);
    expect(MAX_MESSAGES_PER_PROMPT).toBeLessThanOrEqual(100);
  });

  it('CREDENTIAL_PROXY_PORT is a valid port number', () => {
    expect(CREDENTIAL_PROXY_PORT).toBeGreaterThanOrEqual(1);
    expect(CREDENTIAL_PROXY_PORT).toBeLessThanOrEqual(65535);
  });

  it('CONTEXT_PACKET_MAX_SIZE is positive', () => {
    expect(CONTEXT_PACKET_MAX_SIZE).toBeGreaterThan(0);
  });

  it('MAX_CONTAINER_SPAWNS_PER_HOUR is positive', () => {
    expect(MAX_CONTAINER_SPAWNS_PER_HOUR).toBeGreaterThan(0);
  });

  it('MAX_ERRORS_PER_HOUR is positive', () => {
    expect(MAX_ERRORS_PER_HOUR).toBeGreaterThan(0);
  });

  it('CALENDAR_LOOKAHEAD_DAYS is positive and reasonable', () => {
    expect(CALENDAR_LOOKAHEAD_DAYS).toBeGreaterThan(0);
    expect(CALENDAR_LOOKAHEAD_DAYS).toBeLessThanOrEqual(365);
  });
});

// --- Session lifecycle: MAX_AGE > IDLE ---

describe('session lifecycle', () => {
  it('SESSION_IDLE_MS is positive', () => {
    expect(SESSION_IDLE_MS).toBeGreaterThan(0);
  });

  it('SESSION_MAX_AGE_MS is positive', () => {
    expect(SESSION_MAX_AGE_MS).toBeGreaterThan(0);
  });

  it('SESSION_MAX_AGE_MS > SESSION_IDLE_MS (max age exceeds idle)', () => {
    expect(SESSION_MAX_AGE_MS).toBeGreaterThan(SESSION_IDLE_MS);
  });

  it('SESSION_IDLE_MS defaults to 2 hours', () => {
    expect(SESSION_IDLE_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('SESSION_MAX_AGE_MS defaults to 4 hours', () => {
    expect(SESSION_MAX_AGE_MS).toBe(4 * 60 * 60 * 1000);
  });
});

// --- TRIGGER_PATTERN regex matching ---

describe('TRIGGER_PATTERN and buildTriggerPattern', () => {
  it('DEFAULT_TRIGGER starts with @', () => {
    expect(DEFAULT_TRIGGER).toMatch(/^@/);
    expect(DEFAULT_TRIGGER).toBe(`@${ASSISTANT_NAME}`);
  });

  it('TRIGGER_PATTERN matches the default trigger at start of message', () => {
    expect(TRIGGER_PATTERN.test(`${DEFAULT_TRIGGER} hello`)).toBe(true);
  });

  it('TRIGGER_PATTERN is case-insensitive', () => {
    expect(TRIGGER_PATTERN.test(DEFAULT_TRIGGER.toLowerCase() + ' hi')).toBe(
      true,
    );
    expect(TRIGGER_PATTERN.test(DEFAULT_TRIGGER.toUpperCase() + ' hi')).toBe(
      true,
    );
  });

  it('TRIGGER_PATTERN requires word boundary after trigger', () => {
    // "AndyXYZ" should NOT match if trigger is "@Andy"
    const pattern = buildTriggerPattern('@Andy');
    expect(pattern.test('@Andy hello')).toBe(true);
    expect(pattern.test('@AndyXYZ hello')).toBe(false);
  });

  it('TRIGGER_PATTERN does not match trigger in the middle of text', () => {
    expect(TRIGGER_PATTERN.test(`hello ${DEFAULT_TRIGGER}`)).toBe(false);
  });

  it('buildTriggerPattern escapes regex metacharacters in name (regression: #16)', () => {
    // If assistant name contains regex-special chars, they must be escaped
    const pattern = buildTriggerPattern('@Bot.v2');
    expect(pattern.test('@Bot.v2 hi')).toBe(true);
    // The dot should NOT match arbitrary characters
    expect(pattern.test('@BotXv2 hi')).toBe(false);
  });

  it('buildTriggerPattern trims whitespace from trigger', () => {
    const pattern = buildTriggerPattern('  @Andy  ');
    expect(pattern.test('@Andy hello')).toBe(true);
  });

  it('getTriggerPattern uses DEFAULT_TRIGGER when no arg given', () => {
    const pattern = getTriggerPattern();
    expect(pattern.source).toBe(TRIGGER_PATTERN.source);
  });

  it('getTriggerPattern uses custom trigger when provided', () => {
    const pattern = getTriggerPattern('@CustomBot');
    expect(pattern.test('@CustomBot hello')).toBe(true);
    expect(pattern.test(`${DEFAULT_TRIGGER} hello`)).toBe(
      DEFAULT_TRIGGER === '@CustomBot',
    );
  });
});

// --- Timezone ---

describe('TIMEZONE', () => {
  it('is a non-empty string', () => {
    expect(typeof TIMEZONE).toBe('string');
    expect(TIMEZONE.length).toBeGreaterThan(0);
  });

  it('is a valid IANA timezone (Intl can use it)', () => {
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: TIMEZONE })).not.toThrow();
  });
});

// --- Ollama config ---

describe('Ollama config', () => {
  it('OLLAMA_HOST is a valid URL', () => {
    expect(() => new URL(OLLAMA_HOST)).not.toThrow();
  });

  it('OLLAMA_MODEL is a non-empty string', () => {
    expect(typeof OLLAMA_MODEL).toBe('string');
    expect(OLLAMA_MODEL.length).toBeGreaterThan(0);
  });
});
