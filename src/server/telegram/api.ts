/**
 * Minimal Telegram Bot API client on top of global fetch. Only the handful of
 * methods the worker needs; everything is sent as HTML (see escapeHtml).
 */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  username?: string;
  title?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface SendOptions {
  replyMarkup?: InlineKeyboardMarkup;
  replyToMessageId?: number;
  /** Defaults to HTML; pass null to send plain text. */
  parseMode?: "HTML" | "MarkdownV2" | null;
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = "TelegramError";
  }
}

export interface TelegramApi {
  getMe(): Promise<TgUser>;
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<number>;
  editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup?: InlineKeyboardMarkup): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  setMyCommands(commands: BotCommand[]): Promise<void>;
}

const MAX_RETRIES = 3;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function createApi(
  token = process.env.TELEGRAM_BOT_TOKEN,
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): TelegramApi {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const baseUrl = opts.baseUrl ?? "https://api.telegram.org";
  const doFetch = opts.fetch ?? fetch;

  /** POST a method; waits out 429s (retry_after) a few times before giving up. */
  async function call<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Never put the URL in errors: it contains the token.
      const res = await doFetch(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
      const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;
      if (body?.ok) return body.result as T;
      const code = body?.error_code ?? res.status;
      const retryAfter = body?.parameters?.retry_after;
      if (code === 429 && retryAfter !== undefined && attempt < MAX_RETRIES) {
        await sleep(retryAfter * 1000, signal);
        continue;
      }
      throw new TelegramError(method, code, body?.description ?? res.statusText, retryAfter);
    }
  }

  return {
    getMe: () => call<TgUser>("getMe", {}),

    async sendMessage(chatId, text, o = {}) {
      const parseMode = o.parseMode === undefined ? "HTML" : o.parseMode;
      const msg = await call<TgMessage>("sendMessage", {
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(o.replyMarkup ? { reply_markup: o.replyMarkup } : {}),
        ...(o.replyToMessageId
          ? { reply_parameters: { message_id: o.replyToMessageId, allow_sending_without_reply: true } }
          : {}),
        link_preview_options: { is_disabled: true },
      });
      return msg.message_id;
    },

    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      await call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      });
    },

    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    },

    async sendChatAction(chatId, action) {
      await call("sendChatAction", { chat_id: chatId, action });
    },

    getUpdates(offset, timeoutSec, signal) {
      // Give the HTTP request a little more time than the long-poll itself.
      const timeout = AbortSignal.timeout((timeoutSec + 10) * 1000);
      return call<TgUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
        signal ? AbortSignal.any([signal, timeout]) : timeout,
      );
    },

    async setMyCommands(commands) {
      await call("setMyCommands", { commands });
    },
  };
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Chat ids allowed to talk to the bot, from TELEGRAM_CHAT_ID (comma-separated). First = primary. */
export function allowedChatIds(raw = process.env.TELEGRAM_CHAT_ID): number[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s))
    .map(Number);
}
