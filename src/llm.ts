import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'node:child_process';
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

// ─── Claude CLI provider (local `claude` binary, no API key) ──────────────────

function claudeCliPath(): string | undefined {
  // Honor an explicit override; otherwise probe for a `claude` on PATH.
  const explicit = process.env.META_ADS_CLI_CLAUDE_BIN;
  if (explicit) return explicit;
  try {
    const found = execSync('command -v claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

class ClaudeCliProvider implements LlmProvider {
  readonly name = 'claude-cli';
  readonly model: string;
  private bin: string;

  constructor() {
    const bin = claudeCliPath();
    if (!bin) throw new Error('No `claude` CLI found on PATH.');
    this.bin = bin;
    // Default to Sonnet — it's available via the local subscription with no API key.
    this.model = process.env.META_ADS_CLI_CLAUDE_MODEL || 'claude-sonnet-4-5';
  }

  async reasonStructured<T = unknown>(system: string, userContent: string, opts: ReasonOptions): Promise<T> {
    const { spawn } = await import('node:child_process');
    logger.info(`LLM(claude-cli) model=${this.model} bin=${this.bin}`);

    // The CLI has no structured-output param, so instruct the model to emit
    // JSON matching the schema and parse it from the result envelope.
    const prompt = `${system}\n\n${userContent}\n\n`
      + `Respond with ONLY a single JSON object that conforms to this JSON Schema. `
      + `No markdown, no code fences, no prose:\n${JSON.stringify(opts.schema)}`;

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin, [
        '-p', prompt,
        '--model', this.model,
        '--output-format', 'json',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300)}`));
      });
    });

    // --output-format json wraps the reply: { result: "<text>", ... }
    let text: string;
    try {
      const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (envelope.is_error) throw new Error('claude CLI reported an error result.');
      text = (envelope.result ?? '').trim();
    } catch {
      text = stdout.trim(); // fall back to raw stdout if envelope parsing fails
    }

    // The model may still wrap JSON in ```fences``` — strip them.
    const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
    const jsonText = fenced ? fenced[1] : text;
    return JSON.parse(jsonText) as T;
  }
}

// ─── Provider selection ───────────────────────────────────────────────────────

function selectProviderName(): 'anthropic' | 'openai-compatible' | 'claude-cli' | undefined {
  const explicit = (process.env.META_ADS_CLI_LLM_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'anthropic' || explicit === 'claude') return 'anthropic';
  if (explicit === 'openai-compatible' || explicit === 'openai') return 'openai-compatible';
  if (explicit === 'claude-cli' || explicit === 'cli') return 'claude-cli';
  if (explicit) return undefined; // unknown value → treat as unconfigured
  // Auto-detect: prefer an explicit API key, then fall back to the local CLI.
  if (anthropicKey()) return 'anthropic';
  if (openaiKey()) return 'openai-compatible';
  if (claudeCliPath()) return 'claude-cli';
  return undefined;
}

export function isLlmAvailable(): boolean {
  return selectProviderName() !== undefined;
}

/** Human-readable label for the provider that would be used (for diagnostics). */
export function llmProviderLabel(): string {
  const name = selectProviderName();
  if (!name) return 'none';
  if (name === 'claude-cli') return `claude-cli (${process.env.META_ADS_CLI_CLAUDE_MODEL || 'claude-sonnet-4-5'}, no key)`;
  if (name === 'anthropic') return `anthropic (${process.env.META_ADS_CLI_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL})`;
  return `openai-compatible (${process.env.META_ADS_CLI_LLM_MODEL || 'gpt-4o'})`;
}

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  const name = selectProviderName();
  if (!name) {
    throw new Error(
      'No LLM provider configured. Use the local `claude` CLI (no key needed), or set '
      + 'ANTHROPIC_API_KEY, or META_ADS_CLI_LLM_API_KEY + META_ADS_CLI_LLM_BASE_URL '
      + '(any OpenAI-compatible endpoint) to enable AI-backed analysis.'
    );
  }
  cached = name === 'anthropic' ? new AnthropicProvider()
    : name === 'openai-compatible' ? new OpenAICompatibleProvider()
      : new ClaudeCliProvider();
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
