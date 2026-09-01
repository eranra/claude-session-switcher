import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_TOPIC_CLOSE_HOURS,
  idleCloseMs,
  remoteControlConfigFrom,
  startupBlocker,
  type RemoteControlConfig,
  type SettingsReader,
} from '../../telegram/config';
import type { SupervisorConfig } from '../../supervisor/config';

function settings(values: Record<string, unknown> = {}): SettingsReader {
  return {
    getBoolean: (key, fallback) => (key in values ? values[key] as boolean : fallback),
    getNumber: (key, fallback) => (key in values ? values[key] as number : fallback),
    getStringArray: (key, fallback) => (key in values ? values[key] as string[] : fallback),
  };
}

function supervisor(over: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    telegramBotToken: 'tok',
    telegramChatId: '-100999',
    ...over,
  } as SupervisorConfig;
}

function config(over: Partial<RemoteControlConfig> = {}): RemoteControlConfig {
  return {
    enabled: true,
    botToken: 'tok',
    chatId: '-100999',
    allowedUserIds: ['42'],
    idleTopicCloseHours: 24,
    ...over,
  };
}

describe('remoteControlConfigFrom', () => {
  it('is off unless the switch is set', () => {
    expect(remoteControlConfigFrom(settings(), supervisor()).enabled).toBe(false);
  });

  it('reuses the supervisor token and chat id, so the group is shared', () => {
    const cfg = remoteControlConfigFrom(settings(), supervisor());
    expect(cfg.botToken).toBe('tok');
    expect(cfg.chatId).toBe('-100999');
  });

  it('tolerates a missing token and chat id without throwing', () => {
    const cfg = remoteControlConfigFrom(
      settings(), supervisor({ telegramBotToken: null, telegramChatId: null }));
    expect(cfg.botToken).toBe('');
    expect(cfg.chatId).toBe('');
  });

  it('trims ids and drops empty entries, so a stray comma cannot break matching', () => {
    const cfg = remoteControlConfigFrom(
      settings({ 'telegram.allowedUserIds': [' 42 ', '', '  '] }), supervisor());
    expect(cfg.allowedUserIds).toEqual(['42']);
  });

  it('trims a pasted token and chat id', () => {
    const cfg = remoteControlConfigFrom(
      settings(), supervisor({ telegramBotToken: ' tok ', telegramChatId: ' -1 ' }));
    expect(cfg.botToken).toBe('tok');
    expect(cfg.chatId).toBe('-1');
  });

  it('defaults the idle close window', () => {
    expect(remoteControlConfigFrom(settings(), supervisor()).idleTopicCloseHours)
      .toBe(DEFAULT_IDLE_TOPIC_CLOSE_HOURS);
  });
});

describe('startupBlocker', () => {
  it('has nothing to say when the feature is off', () => {
    expect(startupBlocker(config({ enabled: false }))).toBeNull();
  });

  it('passes a complete configuration', () => {
    expect(startupBlocker(config())).toBeNull();
  });

  it('steers a missing token to the environment, because each machine needs its own bot', () => {
    const blocker = startupBlocker(config({ botToken: '' }));
    expect(blocker).toContain('TELEGRAM_BOT_TOKEN');
    expect(blocker).toContain('.env');
  });

  it('reports a missing chat id', () => {
    expect(startupBlocker(config({ chatId: '' }))).toContain('chat id');
  });

  it('refuses to start with an empty allowlist', () => {
    // Starting anyway would connect, create topics, and silently discard every message — which
    // looks like a broken bot rather than an unfinished setup.
    const blocker = startupBlocker(config({ allowedUserIds: [] }));
    expect(blocker).toContain('allowedUserIds');
  });

  it('reports the token before the allowlist, so setup is fixed in order', () => {
    expect(startupBlocker(config({ botToken: '', allowedUserIds: [] }))).toContain('bot token');
  });
});

describe('idleCloseMs', () => {
  it('converts hours to milliseconds', () => {
    expect(idleCloseMs(config({ idleTopicCloseHours: 2 }))).toBe(2 * 3600_000);
  });

  it('never returns zero or a negative window', () => {
    // A zero would close every topic on the pass it was created.
    expect(idleCloseMs(config({ idleTopicCloseHours: 0 }))).toBe(3600_000);
    expect(idleCloseMs(config({ idleTopicCloseHours: -5 }))).toBe(3600_000);
  });
});
