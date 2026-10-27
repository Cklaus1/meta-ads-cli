import { AuthManager } from './auth.js';
import { detectMimeType } from './mime.js';
import logger from './logger.js';
import { parseCents, validateEndpoint } from './validate.js';
import { MetaApiError, NetworkError, PolicyError, UsageError } from './errors.js';
import { loadPolicy, type Policy } from './policy.js';
import { appendJournal, journalEnabled, newJournalId, redact } from './journal.js';

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
  /**
   * Ask Meta to validate this write without applying it
   * (execution_options=["validate_only"]). Also set for every write by --validate.
   */
  validateOnly?: boolean;
  /**
   * This POST only reads (e.g. starting an async insights report), so skip
   * read-only/policy/plan/validate/journal handling for writes.
   */
  readLike?: boolean;
  /** Journal id this write undoes (set by `journal undo`). */
  undoOf?: string;
}

/** Graph API versions look like v26.0; anything else could smuggle a path or query into the base URL. */
export function assertApiVersion(version: string): string {
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new UsageError(`Invalid API version "${version}". Use the form v26.0.`);
  }
  return version;
}

/** Edges where Meta documents execution_options=["validate_only"]; other writes are skipped under --validate. */
const VALIDATABLE_EDGES = new Set(['campaigns', 'adsets', 'ads', 'adcreatives', 'copies']);

/** The method Graph will apply: a POST with method=DELETE (or similar) in its fields is that method. */
export function effectiveMethod(method: string, fields: Record<string, string>): string {
  const override = fields.method;
  return typeof override === 'string' && override ? override.toUpperCase() : method.toUpperCase();
}

/** Placeholder ID prefix used by --plan and --validate for objects that weren't created. */
export const PLACEHOLDER_PREFIX = 'planned_';

/** True for IDs handed out by --plan/--validate instead of a real object ID. */
export function isPlaceholderId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(PLACEHOLDER_PREFIX);
}

/** Client-wide modes and guardrails beyond the positional constructor args. */
export interface ClientOptions {
  /** --plan: run reads for real, but record writes instead of sending them. */
  plan?: boolean;
  /** --validate: send writes with validate_only so nothing changes. */
  validateOnly?: boolean;
  /** --verbose: print request/response timing to stderr. */
  verbose?: boolean;
  /** Overrides from flags for the policy's blockGoingLive/blockDeletes/blockMessaging. */
  allowLive?: boolean;
  allowDelete?: boolean;
  allowMessaging?: boolean;
  /** Policy to enforce; defaults to the policy file. */
  policy?: Policy;
}

/** A write recorded (not sent) in --plan mode. */
export interface PlannedWrite {
  step: number;
  method: string;
  endpoint: string;
  params?: Record<string, string>;
  body?: Record<string, string>;
  file?: string;
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

const STATUS_FIELDS = ['status', 'status_option', 'configured_status'] as const;
// Edges whose POST sends a message to a person.
const MESSAGING_EDGES = new Set(['messages', 'private_replies']);
// Edges whose POST creates an object that can deliver (and spend) once ACTIVE.
const DELIVERING_CREATE_EDGES = new Set(['campaigns', 'adsets', 'ads', 'copies']);

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
  /** Raw rate-limit headers from the latest response (for `meta-ads limits`). */
  private lastUsageHeaders: Record<string, unknown> = {};
  private warnedVersion = false;
  private options: ClientOptions;
  private policy: Policy;
  private planned: PlannedWrite[] = [];
  /** Cache of object id → ad account (act_XXX), or null for non-ad objects. */
  private accountOf = new Map<string, string | null>();
  /** Daily budgets approved by the account ceiling during this process. */
  private approvedBudgets = new Map<string, number>();
  private dryRunWrites = 0;
  /** Serializes budget writes so parallel creates can't each pass the ceiling. */
  private budgetLock: Promise<unknown> = Promise.resolve();

  private async withBudgetLock<T>(fields: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const touchesBudget = this.policy.maxAccountDailyBudgetCents && (fields.daily_budget !== undefined
      || STATUS_FIELDS.some(f => fields[f] === 'ACTIVE'));
    if (!touchesBudget) return fn();
    const run = this.budgetLock.then(fn, fn);
    this.budgetLock = run.catch(() => undefined);
    return run;
  }

  /**
   * Budget schedules raise a budget for a period: ABSOLUTE adds budget_value,
   * MULTIPLIER scales it by budget_value percent. Check the resulting budget,
   * not the increase, against the spend cap.
   */
  private async enforceBudgetSchedule(endpoint: string, fields: Record<string, string>): Promise<void> {
    const segments = endpoint.split('/');
    if (segments[segments.length - 1] !== 'budget_schedules' || fields.budget_value === undefined) return;
    if (!this.maxSpendCapCents) return;
    const value = Number(fields.budget_value);
    if (!Number.isFinite(value)) throw new PolicyError(`Spend-cap guard: budget_value="${fields.budget_value}" is not a number.`);
    let base = 0;
    if (!this.dryRun) {
      try {
        const res = await this.execute(segments[0], 'GET', { params: { fields: 'daily_budget,lifetime_budget' } });
        const d = res.data as { daily_budget?: string; lifetime_budget?: string };
        base = Number(d.daily_budget || d.lifetime_budget || 0);
      } catch (err) {
        throw new PolicyError(`Spend-cap guard: couldn't read ${segments[0]}'s budget to check the schedule (${(err as Error).message}).`);
      }
    }
    const resulting = fields.budget_value_type === 'MULTIPLIER' ? base * (1 + value / 100) : base + value;
    if (resulting > this.maxSpendCapCents) {
      throw new PolicyError(
        `Spend-cap guard: this budget schedule would raise the budget to ${Math.round(resulting)}¢, `
        + `over the spend cap of ${this.maxSpendCapCents}¢.`,
      );
    }
  }

  constructor(auth: AuthManager, dryRun = false, apiVersion?: string, readOnly = false, maxSpendCapCents = 0, options: ClientOptions = {}) {
    this.auth = auth;
    this.dryRun = dryRun;
    this.options = options;
    this.policy = options.policy ?? loadPolicy().policy;
    this.readOnly = readOnly || Boolean(this.policy.readOnly);
    this.apiVersion = assertApiVersion(apiVersion || process.env.META_ADS_CLI_API_VERSION || API_VERSION);
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    // The strictest configured cap wins: a flag can lower the env/profile/policy
    // cap but never raise it.
    const envCap = parseCents(process.env.META_ADS_CLI_MAX_SPEND_CAP, 'META_ADS_CLI_MAX_SPEND_CAP');
    const caps = [maxSpendCapCents, envCap, this.policy.maxSpendCapCents]
      .filter((c): c is number => c !== undefined && c > 0);
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
        throw new PolicyError(`Spend-cap guard: ${field}="${raw}" is not a number of cents, so it can't be checked against the cap.`);
      }
      const cents = Number(str);
      if (cents > this.maxSpendCapCents) {
        throw new PolicyError(
          `Spend-cap guard: ${field}=${cents}¢ ($${(cents / 100).toFixed(2)}) exceeds the `
          + `spend cap of ${this.maxSpendCapCents}¢ ($${(this.maxSpendCapCents / 100).toFixed(2)}). `
          + 'Lower the budget, or ask the account owner to change the cap.',
        );
      }
    }
  }

  private assertWritable(method: string): void {
    if (this.readOnly && method !== 'GET') {
      const why = this.policy.readOnly ? 'the policy file sets readOnly' : 'Remove --read-only to allow writes';
      throw new PolicyError(`Read-only mode: ${method} requests are blocked (${why}).`);
    }
  }

  /** The policy in effect (from the policy file). */
  getPolicy(): Policy {
    return this.policy;
  }

  /** Writes recorded so far in --plan mode. */
  getPlan(): PlannedWrite[] {
    return this.planned;
  }

  isPlanMode(): boolean {
    return Boolean(this.options.plan);
  }

  /** Whether --allow-live is in effect (false in MCP tool calls unless the server allowed it). */
  isLiveAllowed(): boolean {
    return Boolean(this.options.allowLive);
  }

  isValidateMode(): boolean {
    return Boolean(this.options.validateOnly);
  }

  /** True when writes are not actually applied (--dry-run, --plan or --validate). */
  isPreviewMode(): boolean {
    return this.dryRun || this.isPlanMode() || this.isValidateMode();
  }

  /** Raw rate-limit headers from the latest response. */
  getUsageHeaders(): Record<string, unknown> {
    return this.lastUsageHeaders;
  }

  private checkAccountAllowed(account: string, endpoint: string): void {
    const list = this.policy.accountAllowlist;
    if (list && list.length && !list.includes(account)) {
      throw new PolicyError(`Policy: account ${account} is not in the policy's accountAllowlist (request to ${endpoint}).`);
    }
  }

  /** Ad account an object belongs to, looked up once (null for objects that aren't in an ad account). */
  private async lookupAccount(objectId: string): Promise<string | null> {
    if (/^act_\d+$/.test(objectId)) return objectId;
    if (this.accountOf.has(objectId)) return this.accountOf.get(objectId)!;
    let account: string | null = null;
    try {
      const res = await this.execute(objectId, 'GET', { params: { fields: 'account_id' } });
      const id = (res.data as { account_id?: string }).account_id;
      account = id ? (String(id).startsWith('act_') ? String(id) : `act_${id}`) : null;
    } catch (err) {
      // Pages, posts, catalogs etc. have no account_id field, and Meta
      // answers with "nonexisting field" (code 100). Any other failure means
      // we couldn't check, so the policy must not be skipped.
      const e = err as { code?: number; message?: string };
      const noField = e.code === 100 && /account_id/.test(e.message || '');
      if (!noField) {
        throw new PolicyError(`Policy: couldn't verify which ad account ${objectId} belongs to (${e.message || err}). Retry later.`);
      }
      account = null;
    }
    this.accountOf.set(objectId, account);
    return account;
  }

  /**
   * Enforce the policy file on a write: account allowlist, going live,
   * deletes, messaging, and the account-wide daily budget ceiling.
   */
  private async enforcePolicy(endpoint: string, method: string, fields: Record<string, string>, placeholder?: string): Promise<void> {
    const p = this.policy;
    const segments = endpoint.split('/');
    const target = segments[0];
    const edge = segments.length > 1 ? segments[segments.length - 1] : undefined;
    const isBareObject = segments.length === 1;

    if (p.blockDeletes && !this.options.allowDelete) {
      const deleting = method === 'DELETE' || STATUS_FIELDS.some(f => fields[f] === 'DELETED' || fields[f] === 'ARCHIVED');
      if (deleting) {
        throw new PolicyError(`Policy: deletes and archives are blocked (${method} ${endpoint}). Pass --allow-delete to confirm.`);
      }
    }

    if (p.blockMessaging && !this.options.allowMessaging && method === 'POST' && edge && MESSAGING_EDGES.has(edge)) {
      throw new PolicyError(`Policy: sending messages is blocked (${endpoint}). Pass --allow-messaging to confirm.`);
    }

    const setsActive = STATUS_FIELDS.some(f => fields[f] === 'ACTIVE');
    const createsDelivering = method === 'POST' && edge !== undefined && DELIVERING_CREATE_EDGES.has(edge);
    const statusGiven = STATUS_FIELDS.some(f => fields[f] !== undefined);
    if (p.blockGoingLive && !this.options.allowLive) {
      if (setsActive) {
        throw new PolicyError(`Policy: setting objects ACTIVE is blocked (${endpoint}). Pass --allow-live to confirm going live.`);
      }
      if (createsDelivering && !statusGiven) {
        throw new PolicyError(
          `Policy: ${endpoint} has no explicit status, so it may be created ACTIVE. `
          + 'Set the status to PAUSED, or pass --allow-live.',
        );
      }
    }

    const needsAccount = (p.accountAllowlist && p.accountAllowlist.length > 0) || p.maxAccountDailyBudgetCents;
    if (!needsAccount) return;
    if (this.dryRun || placeholder) {
      if (!/^act_\d+$/.test(target)) {
        console.error('[dry-run] Policy account checks need a lookup and were skipped.');
      }
      if (p.maxAccountDailyBudgetCents) console.error('[dry-run] Policy account daily budget check was skipped.');
      if (/^act_\d+$/.test(target)) this.checkAccountAllowed(target, endpoint);
      return;
    }

    const account = await this.lookupAccount(target);
    if (account) this.checkAccountAllowed(account, endpoint);

    if (p.maxAccountDailyBudgetCents) {
      await this.enforceAccountDailyBudget({
        account, endpoint, isBareObject, objectId: isBareObject ? target : undefined,
        fields, setsActive, createsDelivering, statusGiven,
      });
    }
  }

  private async enforceAccountDailyBudget(o: {
    account: string | null; endpoint: string; isBareObject: boolean; objectId?: string;
    fields: Record<string, string>; setsActive: boolean; createsDelivering: boolean; statusGiven: boolean;
  }): Promise<void> {
    const cap = this.policy.maxAccountDailyBudgetCents!;
    const changesBudget = o.fields.daily_budget !== undefined;
    if (!changesBudget && !o.setsActive) return;

    let current: { daily_budget?: string; effective_status?: string } = {};
    if (o.objectId) {
      try {
        const res = await this.execute(o.objectId, 'GET', { params: { fields: 'daily_budget,effective_status,configured_status' } });
        current = res.data as typeof current;
      } catch (err) {
        throw new PolicyError(`Policy: couldn't read ${o.objectId} to check the account daily budget ceiling (${(err as Error).message}).`);
      }
    }
    const currentlyOn = current.effective_status === 'ACTIVE'
      || (current as { configured_status?: string }).configured_status === 'ACTIVE';
    const endsActive = o.setsActive
      || (o.isBareObject && !o.statusGiven && currentlyOn)
      || (o.createsDelivering && !o.statusGiven);
    if (!endsActive) return;
    const newBudget = Number(o.fields.daily_budget ?? current.daily_budget ?? 0);
    if (!newBudget) return;
    if (!o.account) {
      throw new PolicyError(`Policy: can't tell which ad account ${o.endpoint} belongs to, so the account daily budget ceiling can't be checked.`);
    }

    // Count everything that is switched on (or about to deliver), plus
    // budgets this process already approved but Meta may not list yet.
    let total = 0;
    const seen = new Set<string>();
    for (const edge of ['campaigns', 'adsets']) {
      const res = await this.requestAllPages(`${o.account}/${edge}`, {
        params: {
          fields: 'id,daily_budget,configured_status',
          effective_status: '["ACTIVE","IN_PROCESS","WITH_ISSUES","PENDING_REVIEW","PREAPPROVED","PENDING_BILLING_INFO"]',
          limit: '500',
        },
      });
      for (const item of ((res.data as { data?: Array<{ id: string; daily_budget?: string }> }).data || [])) {
        if (item.id === o.objectId) continue;
        seen.add(item.id);
        total += Number(item.daily_budget || 0);
      }
    }
    for (const [key, amount] of this.approvedBudgets) {
      if (key !== o.objectId && !seen.has(key)) total += amount;
    }
    if (total + newBudget > cap) {
      throw new PolicyError(
        `Policy: active daily budgets in ${o.account} would total ${total + newBudget}¢ `
        + `($${((total + newBudget) / 100).toFixed(2)}), over the account ceiling of ${cap}¢ ($${(cap / 100).toFixed(2)}).`,
      );
    }
    this.approvedBudgets.set(o.objectId ?? `pending:${this.approvedBudgets.size}`, newBudget);
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
    const baseUrl = options.baseUrl || this.baseUrl;
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const fields = { ...(options.params || {}), ...(options.body || {}) };
    // Graph treats a POST carrying method=DELETE as a delete, so guardrails
    // and the journal must see the effective method.
    const method = effectiveMethod(options.method || 'GET', fields);

    const first = endpoint.split('/')[0];
    if (/^act_\d+$/.test(first)) this.checkAccountAllowed(first, endpoint);

    // Objects that --plan/--validate only pretended to create can't be read
    // or written; return a stub so multi-step workflows can continue.
    const placeholder = endpoint.split('/').find(isPlaceholderId);
    if (method === 'GET' || options.readLike) {
      if (placeholder) return { data: { id: placeholder, planned: true, data: [] }, status: 0 };
      if (this.dryRun) return this.printDryRun(method, endpoint, options, baseUrl);
      return this.execute(endpoint, method, options);
    }

    this.assertWritable(method);
    // Budget guard: validate before dry-run too, so the limit is caught while
    // previewing. Graph API reads query params on writes too, so check both.
    this.enforceSpendCap(options.body);
    this.enforceSpendCap(options.params);
    if (!placeholder) await this.enforceBudgetSchedule(endpoint, fields);
    await this.withBudgetLock(fields, () => this.enforcePolicy(endpoint, method, fields, placeholder));

    if (this.dryRun) return this.printDryRun(method, endpoint, options, baseUrl);

    if (this.options.plan || placeholder) {
      const step = this.planned.length + 1;
      if (this.options.plan || !this.options.validateOnly) {
        this.planned.push({ step, method, endpoint, params: redact(options.params), body: redact(options.body) });
      }
      const label = this.options.plan ? 'plan' : 'validate';
      const note = this.options.plan ? '' : ' skipped (depends on an object that was only validated, not created)';
      console.error(`[${label}] ${step}. ${method} ${endpoint}${note}${options.body && this.options.plan ? ` ${JSON.stringify(redact(options.body))}` : ''}`);
      // A placeholder id lets later steps of a workflow reference this object.
      return { data: { planned: true, id: `${PLACEHOLDER_PREFIX}${step}`, method, endpoint }, status: 0 };
    }

    const validateOnly = Boolean(options.validateOnly || this.options.validateOnly);
    if (validateOnly) {
      const edge = endpoint.split('/').length > 1 ? endpoint.split('/').pop()! : undefined;
      const supported = method === 'POST' && (edge === undefined || VALIDATABLE_EDGES.has(edge));
      if (!supported) {
        console.error(`[validate] ${method} ${endpoint} skipped (Meta can't validate this request without applying it).`);
        return { data: { validated: false, skipped: true, method, endpoint }, status: 0 };
      }
      if (Object.values(fields).some(v => typeof v === 'string' && v.includes(PLACEHOLDER_PREFIX))) {
        console.error(`[validate] ${method} ${endpoint} skipped (depends on an object that was only validated, not created).`);
        const step = this.planned.length + 1;
        return { data: { validated: false, skipped: true, id: `${PLACEHOLDER_PREFIX}${step}`, method, endpoint }, status: 0 };
      }
      const res = await this.execute(endpoint, method, {
        ...options,
        body: { ...(options.body || {}), execution_options: '["validate_only"]' },
      });
      console.error(`[validate] ${method} ${endpoint}: valid`);
      // A validated create returns no id; hand out a placeholder for later steps.
      const step = this.planned.length + 1;
      this.planned.push({ step, method, endpoint, params: redact(options.params), body: redact(options.body) });
      return { data: { validated: true, id: `${PLACEHOLDER_PREFIX}${step}`, method, endpoint, response: res.data }, status: res.status };
    }

    if (!journalEnabled()) return this.execute(endpoint, method, options);

    // Journal the write, with the previous values of changed fields when the
    // target is a single object we can read first.
    let previous: Record<string, unknown> | undefined;
    const changed = Object.keys(options.body || {}).filter(k => k !== 'execution_options');
    if (method === 'POST' && !endpoint.includes('/') && changed.length) {
      try {
        const before = await this.execute(endpoint, 'GET', {
          params: { fields: changed.join(',') }, accessToken: options.accessToken, baseUrl: options.baseUrl,
        });
        const data = before.data as Record<string, unknown>;
        previous = Object.fromEntries(changed.filter(k => k in data).map(k => [k, data[k]]));
      } catch {
        previous = undefined; // Not every field is readable; the write still proceeds.
      }
    }
    const entry = {
      id: newJournalId(), ts: new Date().toISOString(), method, endpoint,
      params: redact(options.params), body: redact(options.body), previous,
      ...(options.undoOf ? { undo_of: options.undoOf } : {}),
    };
    try {
      const res = await this.execute(endpoint, method, options);
      const d = res.data as Record<string, unknown>;
      const resultId = d.id ?? d.copied_campaign_id ?? d.copied_adset_id ?? d.copied_ad_id;
      appendJournal({ ...entry, status: 'ok', result_id: resultId !== undefined ? String(resultId) : undefined });
      return res;
    } catch (err) {
      appendJournal({ ...entry, status: 'error', error: (err as Error).message });
      throw err;
    }
  }

  private printDryRun(method: string, endpoint: string, options: MetaRequestOptions, baseUrl: string): MetaResponse {
    // Dry-run notes go to stderr so stdout carries only the command's result.
    const url = this.buildUrl(endpoint, options.params, baseUrl);
    console.error(`[dry-run] ${method} ${url}`);
    if (options.body) {
      console.error(`[dry-run] Body: ${JSON.stringify(redact(options.body))}`);
    }
    if (method === 'GET') return { data: { dryRun: true, method, endpoint }, status: 0 };
    // Give writes a placeholder id so later workflow steps can reference them.
    this.dryRunWrites += 1;
    return { data: { dryRun: true, id: `${PLACEHOLDER_PREFIX}${this.dryRunWrites}`, method, endpoint }, status: 0 };
  }

  /** Send a request (with retries and error mapping), bypassing modes and policy. */
  private async execute(endpoint: string, method: string, options: MetaRequestOptions): Promise<MetaResponse> {
    const baseUrl = options.baseUrl || this.baseUrl;
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
      const started = Date.now();
      if (this.options.verbose) console.error(`→ ${method} ${endpoint}${attempt ? ` (retry ${attempt})` : ''}`);

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
      const traceHeader = response.headers?.get?.('x-fb-trace-id') || undefined;
      if (this.options.verbose) {
        console.error(`← ${response.status} ${method} ${endpoint} in ${Date.now() - started}ms${traceHeader ? ` (fbtrace_id ${traceHeader})` : ''}`);
      }

      // Meta sets this when it auto-upgraded the call from an expired version.
      const versionWarning = response.headers?.get?.('x-ad-api-version-warning');
      if (versionWarning && !this.warnedVersion) {
        this.warnedVersion = true;
        console.error(`Meta API version warning: ${versionWarning}`);
      }

      // Record usage from this response for the next call's proactive throttle.
      this.lastUsage = parseUsageHeaders(response.headers);
      this.lastUsageHeaders = readUsageHeaders(response.headers);
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
          throw new MetaApiError(`Meta API error (${response.status}): ${text}`, {
            httpStatus: response.status, fbtraceId: traceHeader, retryable: response.status >= 500,
          });
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
        const details = {
          httpStatus: response.status,
          code: Number.isFinite(errorCode) ? errorCode : undefined,
          subcode: Number.isFinite(errorSubcode) ? errorSubcode : undefined,
          fbtraceId: (errorObj?.fbtrace_id as string | undefined) || traceHeader,
          userTitle: errorObj?.error_user_title as string | undefined,
          userMessage: errorObj?.error_user_msg as string | undefined,
        };

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
          throw new MetaApiError(
            `Meta rate limit reached (code ${errorCode}). `
            + (est ? `Meta estimates ~${Math.round(est / 60)} minute(s) to regain access. ` : '')
            + 'Slow down with --page-delay, or raise META_ADS_CLI_MAX_WAIT_MS to auto-wait longer.',
            { ...details, type: 'rate_limit', retryable: true },
          );
        }

        logger.error(`API error ${response.status}: ${errorMessage}`);

        if (response.status === 401 || errorCode === 190 || errorCode === 102) {
          throw new MetaApiError('Authentication failed. Run: meta-ads auth login', { ...details, type: 'auth' });
        }
        if (response.status === 403 || errorCode === 200) {
          throw new MetaApiError(`Permission denied: ${errorMessage}`, { ...details, type: 'permission' });
        }
        throw new MetaApiError(`Meta API error (${response.status}): ${errorMessage}`, {
          ...details, retryable: response.status >= 500 || errorObj?.is_transient === true,
        });
      }

      // Extract pagination cursor
      // (Meta signals the last page by omitting paging.next.)
      const paging = obj.paging as Record<string, unknown> | undefined;
      const cursors = paging?.cursors as Record<string, string> | undefined;
      const nextCursor = paging?.next ? cursors?.after || undefined : undefined;

      return { data: json, status: response.status, nextCursor };
    }

    throw lastError || new MetaApiError('Request failed after retries', { httpStatus: 0, retryable: true });
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
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const uploadMethod = effectiveMethod('POST', fields);
    this.assertWritable(uploadMethod);
    this.enforceSpendCap(fields);
    await this.enforcePolicy(endpoint, uploadMethod, fields);

    const fs = await import('fs');
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const contentType = detectMimeType(filePath);

    logger.info(`Uploading ${filePath} (${fileSize} bytes, ${contentType})`);

    if (this.dryRun) {
      console.error(`[dry-run] POST ${this.baseUrl}/${endpoint}`);
      console.error(`[dry-run] File: ${filePath} (${fileSize} bytes, ${contentType})`);
      if (Object.keys(fields).length) console.error(`[dry-run] Fields: ${JSON.stringify(fields)}`);
      return { data: { dryRun: true, method: 'POST', fileSize, contentType }, status: 0 };
    }
    if (this.options.plan) {
      const step = this.planned.length + 1;
      this.planned.push({ step, method: 'POST', endpoint, body: redact(fields), file: filePath });
      console.error(`[plan] ${step}. POST ${endpoint} (upload ${filePath}, ${fileSize} bytes)`);
      return { data: { planned: true, id: `${PLACEHOLDER_PREFIX}${step}`, method: 'POST', endpoint }, status: 0 };
    }
    if (this.options.validateOnly) {
      console.error(`[validate] Upload to ${endpoint} skipped (uploads can't be validated without sending the file).`);
      const step = this.planned.length + 1;
      return { data: { validated: false, skipped: true, id: `${PLACEHOLDER_PREFIX}${step}`, method: 'POST', endpoint }, status: 0 };
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

    const journalBase = {
      id: newJournalId(), ts: new Date().toISOString(), method: 'POST', endpoint,
      body: { ...redact(fields), source: filePath },
    };
    if (!response.ok) {
      const errorText = await response.text();
      const err = new MetaApiError(`Upload failed (${response.status}): ${errorText}`, {
        httpStatus: response.status, fbtraceId: response.headers?.get?.('x-fb-trace-id') || undefined,
      });
      appendJournal({ ...journalBase, status: 'error', error: err.message });
      throw err;
    }

    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: 'Upload complete', size: fileSize };
    }
    appendJournal({ ...journalBase, status: 'ok', result_id: data.id !== undefined ? String(data.id) : undefined });
    return { data, status: response.status };
  }
}

/** Turn a fetch rejection (timeout, DNS, reset) into a readable error. */
function networkError(err: unknown, timeoutMs: number): NetworkError {
  const e = err as Error & { cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new NetworkError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
  }
  const code = e?.cause?.code ? ` (${e.cause.code})` : '';
  return new NetworkError(`Network error${code}: ${e?.message || String(err)}`);
}

/** The raw rate-limit usage headers, parsed as JSON where possible. */
function readUsageHeaders(headers: Headers | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!headers || typeof headers.get !== 'function') return out;
  for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-ad-account-usage', 'x-fb-ads-insights-throttle']) {
    const raw = headers.get(h);
    if (!raw) continue;
    try { out[h] = JSON.parse(raw); } catch { out[h] = raw; }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
