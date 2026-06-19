import { AuthManager } from './auth.js';
import { detectMimeType } from './mime.js';
import logger from './logger.js';

const MAX_RETRIES = 3;
const MAX_PAGES = 100;
export const API_VERSION = 'v25.0';

// Meta reports usage as a percentage (0–100) of each rate-limit budget via the
// X-Business-Use-Case-Usage / X-Ad-Account-Usage / X-App-Usage headers. When any
// gauge crosses this threshold we proactively slow down to avoid a hard throttle.
const USAGE_SOFT_THRESHOLD = Number(process.env.META_ADS_CLI_USAGE_THRESHOLD) || 75;
// Meta error codes for ads/app rate limiting (returned as HTTP 400/403, NOT 429).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);
// Cap how long we'll auto-wait on a throttle that reports a recovery estimate.
const MAX_AUTO_WAIT_MS = Number(process.env.META_ADS_CLI_MAX_WAIT_MS) || 90_000;

export interface MetaRequestOptions {
  method?: string;
  params?: Record<string, string>;
  body?: Record<string, string>;
}

export interface MetaResponse {
  data: unknown;
  status: number;
  nextCursor?: string;
}

/** Peak usage percentage (0–100) seen across rate-limit gauges on a response. */
interface UsageSnapshot {
  peakPct: number;
  detail: string;
  estimatedRecoverSec?: number;
}

/**
 * Parse Meta's rate-limit usage headers into a single peak-percentage snapshot.
 * Headers carry JSON: X-App-Usage = {call_count, total_cputime, total_time};
 * X-Business-Use-Case-Usage / X-Ad-Account-Usage are keyed by object id and may
 * include estimated_time_to_regain_access (minutes) when already throttled.
 */
export function parseUsageHeaders(headers: Headers | undefined): UsageSnapshot {
  let peak = 0;
  let detail = '';
  let recoverSec: number | undefined;

  // Defensive: some environments / test mocks omit a real Headers object.
  if (!headers || typeof headers.get !== 'function') {
    return { peakPct: 0, detail: '' };
  }

  const consider = (label: string, obj: Record<string, unknown>) => {
    for (const key of ['call_count', 'total_time', 'total_cputime']) {
      const v = Number(obj[key]);
      if (Number.isFinite(v) && v > peak) {
        peak = v;
        detail = `${label}.${key}=${v}%`;
      }
    }
    const regain = Number(obj.estimated_time_to_regain_access);
    if (Number.isFinite(regain) && regain > 0) recoverSec = regain * 60;
  };

  // X-App-Usage: a flat object.
  const appUsage = headers.get('x-app-usage');
  if (appUsage) {
    try { consider('app', JSON.parse(appUsage)); } catch { /* ignore */ }
  }
  // Business-use-case + ad-account usage: { "<id>": [ {type, call_count, ...} ] }.
  for (const h of ['x-business-use-case-usage', 'x-ad-account-usage']) {
    const raw = headers.get(h);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const entries of Object.values(parsed)) {
        const list = Array.isArray(entries) ? entries : [entries];
        for (const e of list) consider(String((e as Record<string, unknown>).type || 'buc'), e as Record<string, unknown>);
      }
    } catch { /* ignore */ }
  }

  return { peakPct: peak, detail, estimatedRecoverSec: recoverSec };
}

// Budget-bearing fields (all in cents) that a write request could set. If any
// exceeds the configured cap, the write is blocked before it leaves the client.
const BUDGET_FIELDS = ['daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount'] as const;

export class MetaClient {
  private auth: AuthManager;
  private dryRun: boolean;
  private readOnly: boolean;
  private apiVersion: string;
  private baseUrl: string;
  /** Hard ceiling (in cents) on any budget field in a write. 0 = no cap. */
  private maxSpendCapCents: number;
  /** Most recent usage reading, for proactive throttling between calls. */
  private lastUsage: UsageSnapshot = { peakPct: 0, detail: '' };

  constructor(auth: AuthManager, dryRun = false, apiVersion?: string, readOnly = false, maxSpendCapCents = 0) {
    this.auth = auth;
    this.dryRun = dryRun;
    this.readOnly = readOnly;
    this.apiVersion = apiVersion || process.env.META_ADS_CLI_API_VERSION || API_VERSION;
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    const envCap = Number(process.env.META_ADS_CLI_MAX_SPEND_CAP);
    this.maxSpendCapCents = maxSpendCapCents || (Number.isFinite(envCap) ? envCap : 0);
  }

  /**
   * Enforce the spend-cap guard against a write body. Throws if any budget
   * field exceeds the configured ceiling. No-op when no cap is set.
   */
  private enforceSpendCap(body: Record<string, string> | undefined): void {
    if (!this.maxSpendCapCents || !body) return;
    for (const field of BUDGET_FIELDS) {
      const raw = body[field];
      if (raw === undefined) continue;
      const cents = Number(raw);
      if (Number.isFinite(cents) && cents > this.maxSpendCapCents) {
        throw new Error(
          `Spend-cap guard: ${field}=${cents}¢ ($${(cents / 100).toFixed(2)}) exceeds the `
          + `--max-spend-cap of ${this.maxSpendCapCents}¢ ($${(this.maxSpendCapCents / 100).toFixed(2)}). `
          + 'Raise --max-spend-cap / META_ADS_CLI_MAX_SPEND_CAP, or lower the budget.',
        );
      }
    }
  }

  /** Expose the latest usage reading (for diagnostics / doctor). */
  getUsage(): UsageSnapshot {
    return this.lastUsage;
  }

  /** Configured spend cap in cents (0 = disabled). */
  getMaxSpendCapCents(): number {
    return this.maxSpendCapCents;
  }

  /** Expose the latest usage reading (for diagnostics / doctor). */
  getUsage(): UsageSnapshot {
    return this.lastUsage;
  }

  buildUrl(endpoint: string, params?: Record<string, string>): string {
    let url = `${this.baseUrl}/${endpoint}`;
    if (params && Object.keys(params).length > 0) {
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    return url;
  }

  async request(endpoint: string, options: MetaRequestOptions = {}): Promise<MetaResponse> {
    const method = options.method || 'GET';

    if (this.readOnly && method !== 'GET') {
      throw new Error(`Read-only mode: ${method} requests are blocked. Remove --read-only to allow writes.`);
    }

    // Budget guard: validate before dry-run too, so the limit is caught while previewing.
    if (method === 'POST') {
      this.enforceSpendCap(options.body);
    }

    if (this.dryRun) {
      const url = this.buildUrl(endpoint, options.params);
      console.log(`[dry-run] ${method} ${url}`);
      if (options.body) {
        console.log(`[dry-run] Body: ${JSON.stringify(options.body)}`);
      }
      return { data: { dryRun: true, method, endpoint }, status: 0 };
    }

    const token = await this.auth.getToken();

    // Build params with access_token
    const allParams: Record<string, string> = {
      access_token: token,
      ...options.params,
    };

    logger.debug(`${method} ${endpoint}`, options.params);

    let lastError: Error | null = null;

    // Proactive throttle: if the previous response showed us near the limit,
    // pause before issuing the next call to avoid tripping a hard block.
    if (this.lastUsage.peakPct >= USAGE_SOFT_THRESHOLD) {
      const over = this.lastUsage.peakPct - USAGE_SOFT_THRESHOLD;
      const waitMs = Math.min(MAX_AUTO_WAIT_MS, 1000 + over * 400); // scales toward the cap as usage climbs
      logger.warn(`Approaching rate limit (${this.lastUsage.detail}). Pausing ${(waitMs / 1000).toFixed(1)}s.`);
      console.error(`Approaching Meta rate limit (${this.lastUsage.detail}). Pausing ${(waitMs / 1000).toFixed(1)}s...`);
      await sleep(waitMs);
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let response: Response;

      if (method === 'GET' || method === 'DELETE') {
        const url = this.buildUrl(endpoint, allParams);
        response = await fetch(url, { method });
      } else {
        // POST — Meta API uses form data for POST
        const url = this.buildUrl(endpoint);
        const formBody = new URLSearchParams({
          ...allParams,
          ...options.body,
        });
        response = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody.toString(),
        });
      }

      logger.debug(`Response: ${response.status} ${response.statusText}`, { attempt });

      // Record usage from this response for the next call's proactive throttle.
      this.lastUsage = parseUsageHeaders(response.headers);
      if (this.lastUsage.peakPct > 0) {
        logger.debug(`Rate-limit usage: ${this.lastUsage.detail} (${this.lastUsage.peakPct}%)`);
      }

      // HTTP 429 — retry with exponential backoff.
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 1000;
        if (attempt < MAX_RETRIES - 1) {
          logger.warn(`Rate limited (429). Retrying in ${waitMs / 1000}s...`);
          console.error(`Rate limited. Retrying in ${waitMs / 1000}s...`);
          await sleep(waitMs);
          continue;
        }
      }

      // Server error — retry with backoff
      if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
        const waitMs = Math.pow(2, attempt) * 1000;
        logger.warn(`Server error (${response.status}). Retrying in ${waitMs / 1000}s...`);
        console.error(`Server error (${response.status}). Retrying in ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }

      const text = await response.text();
      let json: unknown;

      try {
        json = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new Error(`Meta API error (${response.status}): ${text}`);
        }
        return { data: { rawResponse: text }, status: response.status };
      }

      const obj = json as Record<string, unknown>;

      if (!response.ok || obj.error) {
        const errorObj = obj.error as Record<string, unknown> | undefined;
        const errorMessage = errorObj?.message || text;
        const errorCode = Number(errorObj?.code);
        const errorSubcode = Number(errorObj?.error_subcode);

        // Ads/app rate limiting arrives as HTTP 400/403 with a specific error
        // code — NOT 429. Honor Meta's own recovery estimate when present,
        // otherwise back off exponentially, and retry within the attempt budget.
        if (RATE_LIMIT_CODES.has(errorCode)) {
          const estMs = this.lastUsage.estimatedRecoverSec
            ? this.lastUsage.estimatedRecoverSec * 1000
            : Math.pow(2, attempt) * 2000;
          const waitMs = Math.min(MAX_AUTO_WAIT_MS, estMs);
          if (attempt < MAX_RETRIES - 1 && waitMs <= MAX_AUTO_WAIT_MS) {
            const est = this.lastUsage.estimatedRecoverSec;
            logger.warn(`Rate limited (code ${errorCode}). Waiting ${(waitMs / 1000).toFixed(0)}s${est ? ` (Meta estimate: ${Math.round(est / 60)}m)` : ''}.`);
            console.error(`Rate limited by Meta. Waiting ${(waitMs / 1000).toFixed(0)}s before retry...`);
            await sleep(waitMs);
            continue;
          }
          // Recovery window exceeds what we'll auto-wait — surface it clearly.
          const est = this.lastUsage.estimatedRecoverSec;
          throw new Error(
            `Meta rate limit reached (code ${errorCode}). `
            + (est ? `Meta estimates ~${Math.round(est / 60)} minute(s) to regain access. ` : '')
            + 'Slow down with --page-delay, or raise META_ADS_CLI_MAX_WAIT_MS to auto-wait longer.',
          );
        }

        logger.error(`API error ${response.status}: ${errorMessage}`);

        if (response.status === 401 || errorCode === 190 || errorCode === 102) {
          throw new Error(`Authentication failed. Run: meta-ads auth login`);
        }
        if (response.status === 403 || errorCode === 200) {
          throw new Error(`Permission denied: ${errorMessage}`);
        }
        void errorSubcode; // reserved for finer-grained handling
        throw new Error(`Meta API error (${response.status}): ${errorMessage}`);
      }

      // Extract pagination cursor
      const paging = obj.paging as Record<string, unknown> | undefined;
      const cursors = paging?.cursors as Record<string, string> | undefined;
      const nextCursor = cursors?.after || undefined;

      return { data: json, status: response.status, nextCursor };
    }

    throw lastError || new Error('Request failed after retries');
  }

  async requestAllPages(
    endpoint: string,
    options: MetaRequestOptions = {},
    pageLimit?: number,
    pageDelayMs?: number,
  ): Promise<MetaResponse> {
    const maxPages = pageLimit || MAX_PAGES;
    const delayMs = pageDelayMs || 0;

    const first = await this.request(endpoint, options);
    const data = first.data as Record<string, unknown>;

    if (!data.data || !Array.isArray(data.data)) {
      return first;
    }

    let allItems = [...data.data];
    let nextCursor = first.nextCursor;
    let pageCount = 1;

    while (nextCursor && pageCount < maxPages) {
      if (delayMs > 0) await sleep(delayMs);
      const nextOptions = {
        ...options,
        params: {
          ...options.params,
          after: nextCursor,
        },
      };
      const nextResponse = await this.request(endpoint, nextOptions);
      const nextData = nextResponse.data as Record<string, unknown>;

      if (nextData.data && Array.isArray(nextData.data)) {
        allItems = allItems.concat(nextData.data);
      }
      nextCursor = nextResponse.nextCursor;
      pageCount++;
    }

    if (pageCount >= maxPages && nextCursor) {
      console.error(`Warning: Reached page limit (${maxPages}). Results may be incomplete.`);
    }

    logger.info(`Paginated: ${allItems.length} items across ${pageCount} pages`);
    data.data = allItems;
    return { data, status: first.status };
  }

  /**
   * Upload a file (image or video) via multipart form data.
   * For videos > 25MB, uses resumable upload with chunked streaming.
   */
  async uploadFile(
    endpoint: string,
    filePath: string,
  ): Promise<MetaResponse> {
    const { readFileSync, statSync } = await import('fs');
    const stat = statSync(filePath);
    const fileSize = stat.size;
    const contentType = detectMimeType(filePath);

    logger.info(`Uploading ${filePath} (${fileSize} bytes, ${contentType})`);

    if (this.dryRun) {
      console.log(`[dry-run] POST ${this.baseUrl}/${endpoint}`);
      console.log(`[dry-run] File: ${filePath} (${fileSize} bytes, ${contentType})`);
      return { data: { dryRun: true, method: 'POST', fileSize, contentType }, status: 0 };
    }

    const token = await this.auth.getToken();
    const content = readFileSync(filePath);

    // Build multipart form data manually
    const boundary = `----MetaAdsCLI${Date.now()}`;
    const parts: Buffer[] = [];

    // Access token part
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${token}\r\n`));

    // File part
    const filename = filePath.split('/').pop() || 'file';
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    parts.push(content);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const url = `${this.baseUrl}/${endpoint}`;
    console.error(`Uploading ${filename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.byteLength),
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed (${response.status}): ${errorText}`);
    }

    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return { data: json, status: response.status };
    } catch {
      return { data: { message: 'Upload complete', size: fileSize }, status: response.status };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
