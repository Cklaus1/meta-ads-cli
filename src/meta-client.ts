import { AuthManager } from './auth.js';
import { detectMimeType } from './mime.js';
import logger from './logger.js';
import { parseCents, validateEndpoint } from './validate.js';

const MAX_RETRIES = 3;
const MAX_PAGES = 100;
export const API_VERSION = 'v26.0';

// Meta reports usage as a percentage (0–100) of each rate-limit budget via the
// X-Business-Use-Case-Usage / X-Ad-Account-Usage / X-App-Usage headers. When any
// gauge crosses this threshold we proactively slow down to avoid a hard throttle.
const USAGE_SOFT_THRESHOLD = Number(process.env.META_ADS_CLI_USAGE_THRESHOLD) || 75;
// Meta error codes for ads/app rate limiting (returned as HTTP 400/403, NOT 429).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);
// Cap how long we'll auto-wait on a throttle that reports a recovery estimate.
const MAX_AUTO_WAIT_MS = Number(process.env.META_ADS_CLI_MAX_WAIT_MS) || 90_000;
// Per-request HTTP timeout so a stalled connection can't hang the CLI forever.
const HTTP_TIMEOUT_MS = Number(process.env.META_ADS_CLI_HTTP_TIMEOUT_MS) || 60_000;
const UPLOAD_TIMEOUT_MS = Number(process.env.META_ADS_CLI_UPLOAD_TIMEOUT_MS) || 600_000;
export const THREADS_BASE_URL = 'https://graph.threads.com/v1.0';

export interface MetaRequestOptions {
  method?: string;
  params?: Record<string, string>;
  body?: Record<string, string>;
  /** Use this token instead of the user token (e.g. a Page access token). */
  accessToken?: string;
  /** Override the API base URL (e.g. THREADS_BASE_URL). */
  baseUrl?: string;
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
const BUDGET_FIELDS = [
  'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount', 'bid_cap',
  'daily_spend_cap', 'lifetime_spend_cap', 'daily_min_spend_target', 'lifetime_min_spend_target',
  'budget', 'budget_value',
] as const;

/** Methods that are safe to retry after a 5xx or network error. */
const IDEMPOTENT_METHODS = new Set(['GET', 'DELETE']);

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
  private warnedVersion = false;

  constructor(auth: AuthManager, dryRun = false, apiVersion?: string, readOnly = false, maxSpendCapCents = 0) {
    this.auth = auth;
    this.dryRun = dryRun;
    this.readOnly = readOnly;
    this.apiVersion = apiVersion || process.env.META_ADS_CLI_API_VERSION || API_VERSION;
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    // The strictest configured cap wins: a flag can lower the env/profile cap
    // but never raise it.
    const envCap = parseCents(process.env.META_ADS_CLI_MAX_SPEND_CAP, 'META_ADS_CLI_MAX_SPEND_CAP');
    const caps = [maxSpendCapCents, envCap].filter((c): c is number => c !== undefined && c > 0);
    this.maxSpendCapCents = caps.length ? Math.min(...caps) : 0;
  }

  /**
   * Enforce the spend-cap guard against the fields of a write. Throws if any
   * budget field exceeds the configured ceiling or isn't a plain number of
   * cents. No-op when no cap is set.
   */
  private enforceSpendCap(fields: Record<string, string> | undefined): void {
    if (!this.maxSpendCapCents || !fields) return;
    for (const field of BUDGET_FIELDS) {
      const raw = fields[field];
      if (raw === undefined) continue;
      // A MULTIPLIER budget schedule is a percentage, not an amount.
      if (field === 'budget_value' && fields.budget_value_type === 'MULTIPLIER') continue;
      const str = String(raw).trim();
      if (!/^\d+(\.\d+)?$/.test(str)) {
        throw new Error(`Spend-cap guard: ${field}="${raw}" is not a number of cents, so it can't be checked against the cap.`);
      }
      const cents = Number(str);
      if (cents > this.maxSpendCapCents) {
        throw new Error(
          `Spend-cap guard: ${field}=${cents}¢ ($${(cents / 100).toFixed(2)}) exceeds the `
          + `spend cap of ${this.maxSpendCapCents}¢ ($${(this.maxSpendCapCents / 100).toFixed(2)}). `
          + 'Lower the budget, or ask the account owner to change the cap.',
        );
      }
    }
  }

  private assertWritable(method: string): void {
    if (this.readOnly && method !== 'GET') {
      throw new Error(`Read-only mode: ${method} requests are blocked. Remove --read-only to allow writes.`);
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

  isDryRun(): boolean {
    return this.dryRun;
  }

  getApiVersion(): string {
    return this.apiVersion;
  }

  private pageTokens = new Map<string, string>();

  /**
   * Fetch (and cache) the Page access token for a Page the user manages.
   * Page writes and Messenger calls need it; the user token is rejected.
   * In dry-run mode the user token is returned without a request.
   */
  async getPageToken(pageId: string): Promise<string | undefined> {
    if (this.dryRun) return undefined;
    const cached = this.pageTokens.get(pageId);
    if (cached) return cached;
    const response = await this.request(pageId, { params: { fields: 'access_token' } });
    const token = (response.data as { access_token?: string }).access_token;
    if (!token) {
      throw new Error(`Could not get a Page access token for ${pageId}. Check that you manage this Page and granted pages_show_list.`);
    }
    this.pageTokens.set(pageId, token);
    return token;
  }

  buildUrl(endpoint: string, params?: Record<string, string>, baseUrl = this.baseUrl): string {
    let url = `${baseUrl}/${validateEndpoint(endpoint)}`;
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
    const baseUrl = options.baseUrl || this.baseUrl;
    validateEndpoint(endpoint);

    this.assertWritable(method);

    // Budget guard: validate before dry-run too, so the limit is caught while
    // previewing. Graph API reads query params on writes too, so check both.
    if (method !== 'GET') {
      this.enforceSpendCap(options.body);
      this.enforceSpendCap(options.params);
    }

    if (this.dryRun) {
      const url = this.buildUrl(endpoint, options.params, baseUrl);
      console.log(`[dry-run] ${method} ${url}`);
      if (options.body) {
        console.log(`[dry-run] Body: ${JSON.stringify(options.body)}`);
      }
      return { data: { dryRun: true, method, endpoint }, status: 0 };
    }

    const token = options.accessToken || await this.auth.getToken();

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

    // Creates are not idempotent: Meta can commit a POST and still return a
    // 5xx or drop the connection, so retrying would duplicate the object.
    const canRetryFailure = IDEMPOTENT_METHODS.has(method);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let response: Response;

      try {
        if (method === 'GET' || method === 'DELETE') {
          const url = this.buildUrl(endpoint, allParams, baseUrl);
          response = await fetch(url, { method, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        } else {
          // POST — Meta API uses form data for POST
          const url = this.buildUrl(endpoint, undefined, baseUrl);
          const formBody = new URLSearchParams({
            ...allParams,
            ...options.body,
          });
          response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody.toString(),
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
        }
      } catch (err) {
        lastError = networkError(err, HTTP_TIMEOUT_MS);
        if (canRetryFailure && attempt < MAX_RETRIES - 1) {
          const waitMs = Math.pow(2, attempt) * 1000;
          logger.warn(`${lastError.message}. Retrying in ${waitMs / 1000}s...`);
          console.error(`${lastError.message}. Retrying in ${waitMs / 1000}s...`);
          await sleep(waitMs);
          continue;
        }
        throw lastError;
      }

      logger.debug(`Response: ${response.status} ${response.statusText}`, { attempt });

      // Meta sets this when it auto-upgraded the call from an expired version.
      const versionWarning = response.headers?.get?.('x-ad-api-version-warning');
      if (versionWarning && !this.warnedVersion) {
        this.warnedVersion = true;
        console.error(`Meta API version warning: ${versionWarning}`);
      }

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

      // Server error — retry with backoff (idempotent methods only)
      if (response.status >= 500 && canRetryFailure && attempt < MAX_RETRIES - 1) {
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
        // error_user_title/error_user_msg carry the actionable explanation for
        // most Marketing API validation errors; the plain message is generic.
        const userDetail = [errorObj?.error_user_title, errorObj?.error_user_msg]
          .filter((v): v is string => typeof v === 'string' && v.length > 0).join(': ');
        const errorMessage = errorObj?.message
          ? `${errorObj.message}${userDetail ? ` — ${userDetail}` : ''}`
          : text;
        const errorCode = Number(errorObj?.code);
        const errorSubcode = Number(errorObj?.error_subcode);

        // Ads/app rate limiting arrives as HTTP 400/403 with a specific error
        // code — NOT 429. Honor Meta's own recovery estimate when present,
        // otherwise back off exponentially, and retry within the attempt budget.
        if (RATE_LIMIT_CODES.has(errorCode)) {
          const waitMs = this.lastUsage.estimatedRecoverSec
            ? this.lastUsage.estimatedRecoverSec * 1000
            : Math.pow(2, attempt) * 2000;
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
      // (Meta signals the last page by omitting paging.next.)
      const paging = obj.paging as Record<string, unknown> | undefined;
      const cursors = paging?.cursors as Record<string, string> | undefined;
      const nextCursor = paging?.next ? cursors?.after || undefined : undefined;

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
    // The first page's cursors are stale once everything is merged.
    delete data.paging;
    return { data, status: first.status };
  }

  /**
   * Upload a file (image or video) as multipart form data. Extra form fields
   * (e.g. title, description) are sent alongside the file.
   */
  async uploadFile(
    endpoint: string,
    filePath: string,
    fields: Record<string, string> = {},
    options: Pick<MetaRequestOptions, 'accessToken'> = {},
  ): Promise<MetaResponse> {
    validateEndpoint(endpoint);
    this.assertWritable('POST');

    const fs = await import('fs');
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const contentType = detectMimeType(filePath);

    logger.info(`Uploading ${filePath} (${fileSize} bytes, ${contentType})`);

    if (this.dryRun) {
      console.log(`[dry-run] POST ${this.baseUrl}/${endpoint}`);
      console.log(`[dry-run] File: ${filePath} (${fileSize} bytes, ${contentType})`);
      if (Object.keys(fields).length) console.log(`[dry-run] Fields: ${JSON.stringify(fields)}`);
      return { data: { dryRun: true, method: 'POST', fileSize, contentType }, status: 0 };
    }

    const token = options.accessToken || await this.auth.getToken();
    // Node 20+ can stream the file from disk; older versions read it into memory.
    const openAsBlob = (fs as unknown as { openAsBlob?: (p: string, o?: { type?: string }) => Promise<Blob> }).openAsBlob;
    const blob = openAsBlob
      ? await openAsBlob(filePath, { type: contentType })
      : new Blob([fs.readFileSync(filePath)], { type: contentType });

    // FormData handles boundary generation and filename escaping.
    const form = new FormData();
    form.append('access_token', token);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const filename = filePath.split(/[\\/]/).pop() || 'file';
    form.append('source', blob, filename);

    const url = `${this.baseUrl}/${endpoint}`;
    console.error(`Uploading ${filename} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw networkError(err, UPLOAD_TIMEOUT_MS);
    }

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

/** Turn a fetch rejection (timeout, DNS, reset) into a readable error. */
function networkError(err: unknown, timeoutMs: number): Error {
  const e = err as Error & { cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
  }
  const code = e?.cause?.code ? ` (${e.cause.code})` : '';
  return new Error(`Network error${code}: ${e?.message || String(err)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
