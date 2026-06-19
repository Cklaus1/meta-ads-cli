import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';

/**
 * Generic LLM layer for AI-powered reasoning over Meta Ads data.
 *
 * Provider-agnostic: Claude is the first-class default (official SDK,
 * adaptive thinking, strict structured output), but any OpenAI-compatible
 * chat endpoint (OpenAI, OpenRouter, Together, local Ollama / llama.cpp, …)
 * can be plugged in via environment configuration.
 *
 * Selection (META_ADS_CLI_LLM_PROVIDER):
 *   - "anthropic"        (default) → AnthropicProvider
 *   - "openai-compatible"          → OpenAICompatibleProvider
 *   If unset, the provider is auto-detected from whichever credentials exist.
 *
 * Credentials (first match wins per provider):
 *   Anthropic:        META_ADS_CLI_ANTHROPIC_API_KEY | ANTHROPIC_API_KEY | ANTHROPIC_AUTH_TOKEN
 *   OpenAI-compatible: META_ADS_CLI_LLM_API_KEY | OPENAI_API_KEY
 *     base URL:        META_ADS_CLI_LLM_BASE_URL  (e.g. https://api.openai.com/v1)
 *     model:           META_ADS_CLI_LLM_MODEL
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

export interface ReasonOptions {
  /** JSON Schema the response must conform to (strict structured output). */
  schema: Record<string, unknown>;
  /** Human-readable name for the schema (used by OpenAI-compatible providers). */
  schemaName?: string;
  /** Max output tokens. Default 8000. */
  maxTokens?: number;
  /** Reasoning effort (Anthropic-specific; ignored by providers that lack it). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** A pluggable LLM backend. Implementations return parsed, schema-shaped JSON. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  reasonStructured<T = unknown>(system: string, userContent: string, opts: ReasonOptions): Promise<T>;
}

// ─── Anthropic (Claude) provider ─────────────────────────────────────────────

function anthropicKey(): string | undefined {
  return process.env.META_ADS_CLI_ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || undefined;
}

class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private client: Anthropic;

  constructor() {
    const apiKey = anthropicKey();
    if (!apiKey) throw new Error('No Anthropic API key configured.');
    this.model = process.env.META_ADS_CLI_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    // An explicit key uses x-api-key; ANTHROPIC_AUTH_TOKEN uses bearer auth.
    if (process.env.META_ADS_CLI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey });
    } else {
      this.client = new Anthropic({ authToken: apiKey });
    }
  }

  async reasonStructured<T = unknown>(system: string, userContent: string, opts: ReasonOptions): Promise<T> {
    const maxTokens = opts.maxTokens ?? 8000;
    logger.info(`LLM(anthropic) model=${this.model} maxTokens=${maxTokens} effort=${opts.effort ?? 'high'}`);
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: opts.effort ?? 'high',
          format: { type: 'json_schema', schema: opts.schema },
        },
        system,
        messages: [{ role: 'user', content: userContent }],
      } as Anthropic.MessageStreamParams);

      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        throw new Error('Claude declined to analyze this request.');
      }
      const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      if (!textBlock?.text) throw new Error('Claude returned an empty response.');
      logger.info(`LLM(anthropic) ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);
      return JSON.parse(textBlock.text) as T;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic authentication failed — check your API key.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit hit — wait a moment and retry.');
      if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error (${err.status}): ${err.message}`);
      throw err;
    }
  }
}

// ─── OpenAI-compatible provider (OpenAI, OpenRouter, Ollama, …) ───────────────

function openaiKey(): string | undefined {
  return process.env.META_ADS_CLI_LLM_API_KEY || process.env.OPENAI_API_KEY || undefined;
}

class OpenAICompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    const apiKey = openaiKey();
    if (!apiKey) throw new Error('No OpenAI-compatible API key configured.');
    this.apiKey = apiKey;
    this.baseUrl = (process.env.META_ADS_CLI_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = process.env.META_ADS_CLI_LLM_MODEL || 'gpt-4o';
  }

  async reasonStructured<T = unknown>(system: string, userContent: string, opts: ReasonOptions): Promise<T> {
    const maxTokens = opts.maxTokens ?? 8000;
    logger.info(`LLM(openai-compatible) model=${this.model} base=${this.baseUrl} maxTokens=${maxTokens}`);
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: opts.schemaName || 'response',
            schema: opts.schema,
            strict: true,
          },
        },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 401) throw new Error('LLM authentication failed — check META_ADS_CLI_LLM_API_KEY.');
      if (resp.status === 429) throw new Error('LLM rate limit hit — wait a moment and retry.');
      throw new Error(`LLM API error (${resp.status}): ${text.slice(0, 300)}`);
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned an empty response.');
    logger.info(`LLM(openai-compatible) ${data.usage?.prompt_tokens ?? '?'} in / ${data.usage?.completion_tokens ?? '?'} out`);
    return JSON.parse(content) as T;
  }
}

// ─── Provider selection ───────────────────────────────────────────────────────

function selectProviderName(): 'anthropic' | 'openai-compatible' | undefined {
  const explicit = (process.env.META_ADS_CLI_LLM_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'anthropic' || explicit === 'claude') return 'anthropic';
  if (explicit === 'openai-compatible' || explicit === 'openai') return 'openai-compatible';
  if (explicit) return undefined; // unknown value → treat as unconfigured
  // Auto-detect: prefer Anthropic, fall back to OpenAI-compatible.
  if (anthropicKey()) return 'anthropic';
  if (openaiKey()) return 'openai-compatible';
  return undefined;
}

export function isLlmAvailable(): boolean {
  return selectProviderName() !== undefined;
}

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  const name = selectProviderName();
  if (!name) {
    throw new Error(
      'No LLM provider configured. Set ANTHROPIC_API_KEY (Claude, recommended) or '
      + 'META_ADS_CLI_LLM_API_KEY + META_ADS_CLI_LLM_BASE_URL (any OpenAI-compatible endpoint) '
      + 'to enable AI-backed analysis. Get a Claude key at https://console.anthropic.com/.'
    );
  }
  cached = name === 'anthropic' ? new AnthropicProvider() : new OpenAICompatibleProvider();
  return cached;
}

/** Convenience: reason with the configured provider. */
export function reasonStructured<T = unknown>(
  system: string,
  userContent: string,
  opts: ReasonOptions,
): Promise<T> {
  return getProvider().reasonStructured<T>(system, userContent, opts);
}
