import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { Api, Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { downloadFile, processImage } from '../image.js';
import { logger } from '../logger.js';
import { countPdfPages, indexPdf, computeFileHash } from '../pageindex.js';
import {
  classifySendError,
  trackTransientFailure,
} from '../send-failure-tracker.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const execFileAsync = promisify(execFile);

/** Extensions that can be extracted to text via external tools. */
const EXTRACTABLE_EXTS: Record<string, (filePath: string) => Promise<string>> =
  {
    '.pdf': extractPdfText,
    '.docx': extractDocxText,
  };

async function extractPdfText(filePath: string): Promise<string> {
  // Use absolute path — launchd doesn't include /opt/homebrew/bin in PATH
  const pdftotext =
    process.platform === 'darwin' ? '/opt/homebrew/bin/pdftotext' : 'pdftotext';
  const { stdout } = await execFileAsync(pdftotext, ['-layout', filePath, '-']);
  return stdout;
}

async function extractDocxText(filePath: string): Promise<string> {
  // Use absolute path — launchd doesn't include /opt/homebrew/bin in PATH
  const pandoc =
    process.platform === 'darwin' ? '/opt/homebrew/bin/pandoc' : 'pandoc';
  const { stdout } = await execFileAsync(pandoc, [
    '-f',
    'docx',
    '-t',
    'plain',
    '--wrap=none',
    filePath,
  ]);
  return stdout;
}

/**
 * Download a Telegram file to a temp path, extract text, and clean up.
 * Returns extracted text or null if extraction fails.
 */
async function extractDocumentText(
  fileUrl: string,
  fileName: string,
): Promise<string | null> {
  const ext = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
    : '';
  const extractor = EXTRACTABLE_EXTS[ext];
  if (!extractor) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-doc-'));
  const tmpFile = path.join(tmpDir, fileName);
  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tmpFile, buf);
    return await extractor(tmpFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for dynamic (unpinned) senders
const senderBotMap = new Map<string, number>();
// Maps sender name → pool Api index for pinned senders (global — a pinned bot's
// Telegram display name is global, so one pin covers every group that bot is in).
const pinnedSenderIdx = new Map<string, number>();
let nextPoolIndex = 0;

/** Reset module-level pool state — test-only hook. */
export function _resetPoolStateForTests(): void {
  poolApis.length = 0;
  senderBotMap.clear();
  pinnedSenderIdx.clear();
  nextPoolIndex = 0;
  poolOpts = null;
}

const migratingJids = new Set<string>();
let poolOpts: TelegramChannelOpts | null = null;

async function handleMigration(
  err: unknown,
  chatId: string,
  text: string,
  api: { sendMessage: Api['sendMessage'] },
  opts: TelegramChannelOpts,
): Promise<boolean> {
  if (!(err instanceof GrammyError)) return false;
  const params = (err as any).parameters as
    | { migrate_to_chat_id?: number }
    | undefined;
  if (err.error_code !== 400 || !params?.migrate_to_chat_id) return false;

  const oldJid = `tg:${chatId}`;
  const newChatId = params.migrate_to_chat_id;
  const newJid = `tg:${newChatId}`;

  // Concurrency guard: another send is already migrating this JID
  if (migratingJids.has(oldJid)) {
    await sendTelegramMessage(api, String(newChatId), text);
    return true;
  }

  migratingJids.add(oldJid);
  try {
    await opts.onMigrate?.(oldJid, newJid);
    await sendTelegramMessage(api, String(newChatId), text);
  } finally {
    migratingJids.delete(oldJid);
  }
  return true;
}

/**
 * Initialize send-only Api instances for the bot pool.
 *
 * `pins` maps Telegram bot username → agent sender name. When provided, each
 * pinned bot is pre-renamed at init and will always carry that sender's
 * messages (instead of dynamic round-robin).
 */
export async function initBotPool(
  tokens: string[],
  pins: Record<string, string> = {},
): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      const idx = poolApis.length - 1;
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );

      const pinnedSender = me.username ? pins[me.username] : undefined;
      if (pinnedSender) {
        pinnedSenderIdx.set(pinnedSender, idx);
        try {
          await api.setMyName(pinnedSender);
          logger.info(
            { botUsername: me.username, pinnedSender, poolIndex: idx },
            'Pool bot pinned and pre-renamed',
          );
        } catch (err) {
          logger.warn(
            { botUsername: me.username, pinnedSender, err },
            'Failed to pre-rename pinned pool bot (pin kept, will send anyway)',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info(
      { count: poolApis.length, pinned: pinnedSenderIdx.size },
      'Telegram bot pool ready',
    );
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
/**
 * Send a message via a pool bot assigned to the given sender name.
 * Returns false if the pool bot can't reach the chat (e.g. 403 in DMs),
 * so the caller can fall back to the main bot.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<boolean> {
  if (poolApis.length === 0) {
    return false;
  }

  // Pinned senders always use their assigned bot (pre-renamed at init —
  // no rename call needed here).
  const pinnedIdx = pinnedSenderIdx.get(sender);
  let idx: number;
  if (pinnedIdx !== undefined) {
    idx = pinnedIdx;
  } else {
    const key = `${groupFolder}:${sender}`;
    const existing = senderBotMap.get(key);
    if (existing !== undefined) {
      idx = existing;
    } else {
      // Dynamic round-robin fallback. Skip any pool indices that are pinned —
      // renaming them would clobber the pinned display name globally.
      const pinnedIndices = new Set(pinnedSenderIdx.values());
      const freeCount = poolApis.length - pinnedIndices.size;
      if (freeCount <= 0) {
        logger.warn(
          { sender, groupFolder, poolSize: poolApis.length },
          'All pool bots are pinned — unpinned sender will reuse a pinned bot without renaming',
        );
        idx = nextPoolIndex % poolApis.length;
      } else {
        // Advance until we hit an unpinned index.
        let candidate = nextPoolIndex % poolApis.length;
        for (let i = 0; i < poolApis.length; i++) {
          if (!pinnedIndices.has(candidate)) break;
          candidate = (candidate + 1) % poolApis.length;
        }
        idx = candidate;
      }
      nextPoolIndex = (idx + 1) % poolApis.length;
      senderBotMap.set(key, idx);

      if (!pinnedIndices.has(idx)) {
        try {
          await poolApis[idx].setMyName(sender);
          await new Promise((r) => setTimeout(r, 2000));
          logger.info(
            { sender, groupFolder, poolIndex: idx },
            'Assigned and renamed pool bot',
          );
        } catch (err) {
          logger.warn(
            { sender, err },
            'Failed to rename pool bot (sending anyway)',
          );
        }
      }
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
    return true;
  } catch (err: unknown) {
    // Handle supergroup migration
    if (poolOpts) {
      try {
        const migrated = await handleMigration(
          err,
          chatId.replace(/^tg:/, ''),
          text,
          api,
          poolOpts,
        );
        if (migrated) return true;
      } catch {
        // migration retry failed — fall through
      }
    }

    const errorCode =
      err && typeof err === 'object' && 'error_code' in err
        ? (err as { error_code: number }).error_code
        : 0;
    if (errorCode === 403) {
      logger.info(
        { chatId, sender },
        'Pool bot cannot reach chat, falling back to main bot',
      );
      return false;
    }
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAlert?: (message: string) => void;
  onMigrate?: (oldJid: string, newJid: string) => Promise<void>;
  onSendFailure?: (service: string, message: string) => void;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    poolOpts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Telegram provides multiple sizes; pick the largest
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];

      try {
        const file = await ctx.api.getFile(largest.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const buffer = await downloadFile(url);
        const image = await processImage(buffer);

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `[Photo]${caption}`,
          timestamp,
          is_from_me: false,
          images: [image],
        });

        logger.info(
          { chatJid, sender: senderName, size: buffer.length },
          'Telegram photo processed for vision',
        );
      } catch (err) {
        logger.warn({ err, chatJid }, 'Failed to process Telegram photo');
        storeNonText(ctx, '[Photo]'); // graceful fallback
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';

      // For text-readable files, download and include the content
      const textExts = [
        '.txt',
        '.md',
        '.json',
        '.csv',
        '.xml',
        '.yaml',
        '.yml',
        '.html',
        '.htm',
        '.css',
        '.js',
        '.ts',
        '.py',
        '.sh',
        '.log',
        '.ini',
        '.cfg',
        '.toml',
        '.env',
        '.sql',
        '.r',
        '.tex',
        '.bib',
        '.tsv',
      ];
      const ext = name.includes('.')
        ? name.slice(name.lastIndexOf('.')).toLowerCase()
        : '';
      const isText =
        textExts.includes(ext) ||
        (doc?.mime_type?.startsWith('text/') ?? false);

      if (isText && doc?.file_id) {
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const content = await resp.text();
            // Telegram Bot API file size limit is 20MB; truncate large files
            const maxChars = 50_000;
            const truncated =
              content.length > maxChars
                ? content.slice(0, maxChars) +
                  `\n\n[Truncated — ${content.length} chars total]`
                : content;
            storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
            logger.info(
              { name, chars: content.length },
              'Telegram document downloaded',
            );
            return;
          }
        } catch (err) {
          logger.warn({ name, err }, 'Failed to download Telegram document');
        }
      }

      // Try extracting text from binary documents (PDF, DOCX, etc.)
      if (doc?.file_id && EXTRACTABLE_EXTS[ext]) {
        // Special handling for PDFs: auto-index long documents
        if (ext === '.pdf') {
          const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'nanoclaw-pdf-'),
          );
          const tmpFile = path.join(tmpDir, name);
          try {
            const file = await ctx.api.getFile(doc.file_id);
            const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
            const resp = await fetch(url);
            if (!resp.ok) {
              storeNonText(ctx, `[Document: ${name}]`);
              return;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(tmpFile, buf);

            const pageCount = await countPdfPages(tmpFile);
            if (pageCount > 20) {
              // Long PDF — auto-index
              await ctx.api.sendChatAction(ctx.chat.id, 'typing');
              const hash = computeFileHash(buf);

              // Determine vault dir from group's additionalMounts config
              const chatJid = `tg:${ctx.chat.id}`;
              const group = this.opts.registeredGroups()[chatJid];
              let vaultDir: string | undefined;
              let inboxDir: string | undefined;
              if (group?.containerConfig?.additionalMounts) {
                for (const m of group.containerConfig.additionalMounts) {
                  if (fs.existsSync(m.hostPath)) {
                    inboxDir = path.join(m.hostPath, '00-inbox');
                    vaultDir = inboxDir;
                    break;
                  }
                }
              }

              const result = await indexPdf(tmpFile, name, {
                vaultDir,
                contentHash: hash,
                fileBuffer: buf,
              });

              if (result.success && result.tree) {
                // Save PDF to vault 00-inbox/
                if (inboxDir) {
                  try {
                    fs.mkdirSync(inboxDir, { recursive: true });
                    fs.writeFileSync(path.join(inboxDir, name), buf);
                    logger.info({ name, inboxDir }, 'PDF saved to vault inbox');
                  } catch (saveErr) {
                    logger.warn(
                      { name, err: saveErr },
                      'Failed to save PDF to vault inbox',
                    );
                  }
                }
                storeNonText(
                  ctx,
                  `[Document: ${name} — ${pageCount} pages, indexed]\n\n${JSON.stringify(result.tree, null, 2)}`,
                );
                logger.info({ name, pageCount }, 'Telegram PDF indexed');
                return;
              } else if (
                result.fallbackText &&
                result.fallbackText.trim().length > 0
              ) {
                const maxChars = 50_000;
                const truncated =
                  result.fallbackText.length > maxChars
                    ? result.fallbackText.slice(0, maxChars) +
                      `\n\n[Truncated — ${result.fallbackText.length} chars total]`
                    : result.fallbackText;
                storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
                logger.info(
                  { name, chars: result.fallbackText.length, pageCount },
                  'Telegram PDF extracted (fallback)',
                );
                return;
              } else {
                storeNonText(ctx, `[Document: ${name}]`);
                return;
              }
            }

            // Short PDF (≤20 pages) — use existing extraction flow
            try {
              const extracted = await extractPdfText(tmpFile);
              if (extracted && extracted.trim().length > 0) {
                const maxChars = 50_000;
                const truncated =
                  extracted.length > maxChars
                    ? extracted.slice(0, maxChars) +
                      `\n\n[Truncated — ${extracted.length} chars total]`
                    : extracted;
                storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
                logger.info(
                  { name, chars: extracted.length },
                  'Telegram document extracted',
                );
                return;
              }
            } catch (extractErr) {
              logger.warn(
                { name, err: extractErr },
                'Failed to extract short PDF text',
              );
            }
          } catch (err) {
            logger.warn({ name, err }, 'Failed to process Telegram PDF');
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
          storeNonText(ctx, `[Document: ${name}]`);
          return;
        }

        // Non-PDF extractable documents (DOCX, etc.)
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const extracted = await extractDocumentText(url, name);
          if (extracted && extracted.trim().length > 0) {
            const maxChars = 50_000;
            const truncated =
              extracted.length > maxChars
                ? extracted.slice(0, maxChars) +
                  `\n\n[Truncated — ${extracted.length} chars total]`
                : extracted;
            storeNonText(ctx, `[Document: ${name}]\n\n${truncated}`);
            logger.info(
              { name, chars: extracted.length },
              'Telegram document extracted',
            );
            return;
          }
        } catch (err) {
          logger.warn(
            { name, err },
            'Failed to extract Telegram document text',
          );
        }
      }

      // Fallback: placeholder for binary files or download failures
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle Mini App data submitted via Telegram.WebApp.sendData()
    // Note: web_app_data only fires in private (DM) chats with the bot.
    this.bot.on('message:web_app_data', async (ctx) => {
      try {
        const webAppData = ctx.message.web_app_data;
        if (!webAppData?.data) {
          logger.warn('Received web_app_data with no data');
          return;
        }

        const chatJid = `tg:${ctx.chat.id}`;
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) return;

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          false,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          // Prefix so agents can identify Mini App responses
          content: `[Mini App Data] ${webAppData.data}`,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatId: ctx.chat.id, dataLength: webAppData.data.length },
          'Received web_app_data from Mini App',
        );
      } catch (err) {
        logger.error({ err }, 'Error handling web_app_data');
      }
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Register slash commands for Telegram autocomplete
    await this.bot.api.setMyCommands([
      { command: 'new', description: 'Start a fresh session' },
      { command: 'status', description: 'Show system status' },
      { command: 'compact', description: 'Compress conversation context' },
      { command: 'tasks', description: 'Show scheduled tasks' },
      { command: 'chatid', description: "Show this chat's registration ID" },
    ]);

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      const numericId = jid.replace(/^tg:/, '');

      // Handle supergroup migration
      try {
        const migrated = await handleMigration(
          err,
          numericId,
          text,
          this.bot!.api,
          this.opts,
        );
        if (migrated) return;
      } catch {
        // migration retry failed — fall through
      }

      // Classify and escalate
      const errorCode =
        err && typeof err === 'object' && 'error_code' in err
          ? (err as { error_code: number }).error_code
          : 0;
      const description = err instanceof Error ? err.message : String(err);

      const category = classifySendError(errorCode, description);

      if (category === 'structural') {
        this.opts.onSendFailure?.(
          'Telegram',
          `Structural error sending to ${jid}: ${description}. Messages will continue failing until fixed.`,
        );
      } else {
        const alert = trackTransientFailure(jid);
        if (alert) {
          const msg =
            alert.type === 'global-outage'
              ? `Telegram API outage: ${alert.count} groups affected in ${alert.windowMinutes}m`
              : `${alert.count} failures to ${jid} in ${alert.windowMinutes}m — possible Telegram API issue`;
          this.opts.onSendFailure?.('Telegram', msg);
        }
      }

      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^tg:/, '');
      const inputFile = new InputFile(filePath);
      await this.bot.api.sendDocument(chatId, inputFile, {
        caption,
        parse_mode: caption ? 'Markdown' : undefined,
      });
      logger.info({ jid, filePath }, 'Telegram file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram file');
    }
  }

  /**
   * Send a Telegram Mini App button via an inline keyboard.
   * When the user taps the button, Telegram opens the given HTTPS URL as a WebApp.
   * The URL must be HTTPS (Vercel deployments always are).
   */
  async sendWebAppButton(
    jid: string,
    label: string,
    url: string,
  ): Promise<void> {
    if (!this.bot) {
      throw new Error(
        'Telegram bot not initialized — cannot send WebApp button',
      );
    }
    const chatId = jid.replace(/^tg:/, '');
    // Use url() not webApp() — webApp buttons require BotFather domain registration
    const keyboard = new InlineKeyboard().url(label, url);
    try {
      await this.bot.api.sendMessage(chatId, label, { reply_markup: keyboard });
      logger.info({ chatId, label, url }, 'Telegram WebApp button sent');
    } catch (err) {
      logger.error(
        { chatId, label, url, err },
        'Failed to send Telegram WebApp button',
      );
      throw err;
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
