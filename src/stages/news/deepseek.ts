import axios from 'axios';
import { env } from '../../config/config';

/**
 * Minimal DeepSeek client for the news stage. It calls DeepSeek's Messages endpoint — the one
 * that runs server-side web search (https://api-docs.deepseek.com/guides/anthropic_api); the
 * path segment in the URL is DeepSeek's, not a second provider. Plain Bearer auth with
 * DEEPSEEK_API_KEY, no SDK (verified 2026-10-07: HTTP 200 with web_search results).
 */
const URL = 'https://api.deepseek.com/anthropic/v1/messages';

export interface Block {
  type: string;            // 'text' | 'thinking' | 'server_tool_use' | 'web_search_tool_result' | ...
  text?: string;
  content?: unknown;       // web_search_tool_result: [{ url, title, ... }] or an error object
}
export interface Message { role: 'user' | 'assistant'; content: string | Block[] }
export interface Reply { content: Block[]; stop_reason: string }

export class DeepSeekError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function createMessage(body: {
  model: string;
  max_tokens: number;
  messages: Message[];
  tools?: { type: string; name: string; max_uses?: number }[];
  thinking?: { type: 'disabled' | 'enabled' };
}): Promise<Reply> {
  if (!env.DEEPSEEK_API_KEY) throw new DeepSeekError(401, 'DEEPSEEK_API_KEY is missing from .env');
  const res = await axios.post(URL, body, {
    headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
    timeout: 180_000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    const msg = res.data?.error?.message ?? JSON.stringify(res.data ?? '').slice(0, 300);
    throw new DeepSeekError(res.status, `HTTP ${res.status}: ${msg}`);
  }
  return res.data as Reply;
}
