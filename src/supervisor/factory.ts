/**
 * Build a wired `Orchestrator` from a `SupervisorConfig`.
 *
 * Replaces the `_build_*` helpers in `supervise.py`. Shared by the CLI and by the extension's
 * in-process `SupervisionService`, so both drive an identically-configured supervisor.
 */

import * as path from 'path';
import { AgentController, OutboxAgentController } from './agentControl';
import {
  SupervisorConfig,
  ensureDirs,
  historyDir,
  inboxDir,
  notificationsDir,
  outboxDir,
  recordsDir,
} from './config';
import { BobCliEngine, ClassifierEngine, ClaudeCodeEngine } from './engine';
import { MessagingChannel, StubChannel } from './messaging';
import { Orchestrator } from './orchestrator';
import { StateStore } from './store';
import { TelegramChannel } from './telegram';
import { FileTranscriptSource } from './transcript';
import { FetchFn } from './knowledge';

export type Logger = (msg: string) => void;

/**
 * @param updateSource When given, the Telegram channel takes its updates from here instead of
 * calling `getUpdates`. Used when the remote interface is active: a bot token has one destructive
 * update stream, so it owns the read and forwards supervision what belongs to it.
 */
export function buildChannel(
  config: SupervisorConfig,
  log: Logger = () => { /* silent */ },
  updateSource?: () => Array<Record<string, unknown>>,
): MessagingChannel {
  if (config.messagingChannel === 'telegram') {
    if (config.telegramBotToken && config.telegramChatId) {
      return new TelegramChannel({
        token: config.telegramBotToken,
        chatId: config.telegramChatId,
        offsetPath: path.join(config.stateDir, 'telegram_offset.txt'),
        timeoutMinutes: config.orangeResponseTimeoutMinutes,
        longPollSeconds: 10, // getUpdates returns instantly on a tap/reply
        log,
        updateSource,
      });
    }
    log('warning: messaging channel is telegram but the bot token / chat id are missing; '
      + 'using the stub channel instead.');
  }
  return new StubChannel(notificationsDir(config), inboxDir(config), undefined, log);
}

/** Select the classifier CLI. Default: IBM Bob Shell; `SUPERVISOR_ENGINE=claude` for Claude. */
export function buildEngine(config: SupervisorConfig): ClassifierEngine {
  if (config.supervisorEngine === 'claude') {
    return new ClaudeCodeEngine({
      cliPath: config.claudeCliPath,
      cwd: config.workspaceRoot,
      timeoutSeconds: config.classifierTimeoutSeconds,
      anthropicBaseUrl: config.anthropicBaseUrl,
      anthropicAuthToken: config.anthropicAuthToken,
    });
  }
  return new BobCliEngine({
    cliPath: config.bobCliPath,
    // cwd omitted on purpose: an isolated empty temp dir, never the workspace (see BobCliEngine).
    timeoutSeconds: config.classifierTimeoutSeconds,
    apiKey: config.bobShellApiKey,
  });
}

export interface BuildOrchestratorOptions {
  config: SupervisorConfig;
  /** Point at a specific transcript export file (offline / manual runs). */
  transcriptOverride?: string;
  /** Called after each delivery is written, so the applier can run at once. */
  onDelivered?: () => void;
  /** Override the delivery side entirely (tests). */
  agentController?: AgentController;
  channel?: MessagingChannel;
  engine?: ClassifierEngine;
  knowledgeFetch?: FetchFn;
  log?: Logger;
}

export function buildOrchestrator(opts: BuildOrchestratorOptions): Orchestrator {
  const { config } = opts;
  ensureDirs(config);
  const log = opts.log ?? (() => { /* silent */ });
  return new Orchestrator({
    config,
    store: new StateStore(recordsDir(config)),
    transcriptSource: new FileTranscriptSource(historyDir(config), opts.transcriptOverride),
    engine: opts.engine ?? buildEngine(config),
    channel: opts.channel ?? buildChannel(config, log),
    agentController: opts.agentController
      ?? new OutboxAgentController(outboxDir(config), opts.onDelivered),
    knowledgeFetch: opts.knowledgeFetch,
    log,
  });
}
