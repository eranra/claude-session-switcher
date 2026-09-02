/**
 * Settings for the Telegram remote-control feature.
 *
 * Only two settings are new. The bot token and chat id are reused from the supervision settings
 * (`sessionSitter.supervisor.telegram*`), because remote control and supervision belong in the
 * *same* group — a decision card for a session and the conversation with that session should not
 * live in two different places.
 *
 * ## Why one bot per machine, and why the token should not be a setting
 *
 * A bot token has one update stream and reading it is destructive, so two machines sharing a token
 * steal each other's messages. Each machine therefore needs its own bot. VS Code's User settings
 * are exactly the wrong place to keep that: Settings Sync would copy one machine's token to all of
 * them, recreating the problem invisibly.
 *
 * So the token is best kept per machine, in the environment or a `.env` file, which the existing
 * config layer already reads as a fallback. The setting still works — it is checked first — but the
 * documentation steers to the environment, and `describeTokenSource` reports which one was used so
 * a synced-token mistake is at least visible in the log.
 */

import type { SupervisorConfig } from '../supervisor/config';

export interface RemoteControlConfig {
  /** The master switch. Off means nothing in this feature runs at all. */
  enabled: boolean;
  botToken: string;
  /** Forum group id. Negative for a group, which is normal and not an error. */
  chatId: string;
  /** Telegram user ids permitted to drive the bot. Empty authorises nobody. */
  allowedUserIds: string[];
}

/** What a settings reader has to provide. Keeps this module free of the `vscode` module. */
export interface SettingsReader {
  getBoolean(key: string, fallback: boolean): boolean;
  getStringArray(key: string, fallback: string[]): string[];
}

/**
 * Build the config from settings plus the already-resolved supervisor config (which has done the
 * environment and `.env` fallback for the token and chat id).
 *
 * Ids are normalised to trimmed strings because Telegram ids are numeric but arrive as JSON numbers
 * or strings depending on where they were copied from, and a numeric `12345` that fails to match
 * the string `"12345"` is a silent authorisation failure — the worst kind.
 */
export function remoteControlConfigFrom(
  settings: SettingsReader, supervisor: SupervisorConfig,
): RemoteControlConfig {
  return {
    enabled: settings.getBoolean('telegram.remoteControl', false),
    botToken: (supervisor.telegramBotToken ?? '').trim(),
    chatId: (supervisor.telegramChatId ?? '').trim(),
    allowedUserIds: settings
      .getStringArray('telegram.allowedUserIds', [])
      .map(id => String(id).trim())
      .filter(id => id.length > 0),
  };
}

/**
 * Why the feature cannot start, or null when it can.
 *
 * An empty allowlist is a hard stop rather than a warning. The feature would otherwise run,
 * connect, create topics and silently discard every message — which looks like a bug in the bot
 * rather than an unfinished setup.
 */
export function startupBlocker(config: RemoteControlConfig): string | null {
  if (!config.enabled) { return null; }
  if (!config.botToken) {
    return 'no bot token: set TELEGRAM_BOT_TOKEN in the environment or a .env file '
      + '(preferred, since each machine needs its own bot), or '
      + 'sessionSitter.supervisor.telegramBotToken';
  }
  if (!config.chatId) {
    return 'no chat id: set TELEGRAM_CHAT_ID or sessionSitter.supervisor.telegramChatId '
      + 'to the forum group id';
  }
  if (config.allowedUserIds.length === 0) {
    return 'sessionSitter.telegram.allowedUserIds is empty, so no sender is authorised. '
      + 'Message the group and the ids that were seen are logged for you to copy in';
  }
  return null;
}
