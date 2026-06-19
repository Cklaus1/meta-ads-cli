import { Command } from 'commander';
import { AuthManager } from '../auth.js';
import { MetaClient, API_VERSION } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { isLlmAvailable, llmProviderLabel } from '../llm.js';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

const ICON: Record<CheckStatus, string> = {
  ok: '✓',
  warn: '⚠',
  fail: '✗',
  info: 'ℹ',
};

// Graph API versions known to be on a deprecation path or past it (as of v25 era).
// Calls below v22.0 are rejected by Meta; the current version is v25.0.
const MIN_SUPPORTED_VERSION = 22;
const CURRENT_VERSION = 25;

// Scopes the CLI's major command groups depend on.
const SCOPE_REQUIREMENTS: Array<{ scope: string; enables: string }> = [
  { scope: 'ads_read', enables: 'reading campaigns, insights, analytics' },
  { scope: 'ads_management', enables: 'creating/editing campaigns, ad sets, ads' },
  { scope: 'read_insights', enables: 'performance insights' },
  { scope: 'business_management', enables: 'Business Manager (accounts, pixels, users)' },
  { scope: 'pages_show_list', enables: 'listing Facebook Pages' },
  { scope: 'pages_read_engagement', enables: 'reading post comments/engagement' },
  { scope: 'pages_manage_engagement', enables: 'replying to / hiding / deleting comments' },
  { scope: 'leads_retrieval', enables: 'lead form retrieval' },
];

function parseMajorVersion(v: string): number {
  const m = /v?(\d+)/.exec(v);
  return m ? parseInt(m[1], 10) : NaN;
}

export function registerDoctorCommand(
  program: Command,
  getAuth: () => AuthManager,
  getClient: () => MetaClient,
): void {
  program
    .command('doctor')
    .description('Preflight check: token validity, scopes, API version, deprecations, and LLM config')
    .option('--account-id <id>', 'Ad account ID to test access against (act_XXX)', process.env.META_ADS_CLI_ACCOUNT_ID)
    .option('-o, --output <format>', 'Output format', 'text')
    .action(handleErrors(async (opts) => {
      const checks: Check[] = [];
      const auth = getAuth();
      await auth.initialize();

      // ── 1. Token presence & validity ──────────────────────────────────────
      let tokenValid = false;
      let token = '';
      try {
        token = await auth.getToken();
        const login = await auth.verifyLogin();
        if (login.success && login.user) {
          tokenValid = true;
          checks.push({
            name: 'Access token',
            status: 'ok',
            detail: `Valid — authenticated as ${login.user.name} (ID: ${login.user.id})`,
          });
        } else {
          checks.push({
            name: 'Access token',
            status: 'fail',
            detail: 'Token present but rejected by Meta (expired or invalid).',
            fix: 'Generate a fresh token, or run: meta-ads auth login',
          });
        }
      } catch (err) {
        checks.push({
          name: 'Access token',
          status: 'fail',
          detail: (err as Error).message,
          fix: 'Set META_ADS_CLI_ACCESS_TOKEN or run: meta-ads auth login',
        });
      }

      // ── 2. Token metadata: expiry & scopes (via debug_token) ───────────────
      const grantedScopes = new Set<string>();
      if (tokenValid) {
        const appId = process.env.META_ADS_CLI_APP_ID || process.env.META_APP_ID || '';
        const appSecret = process.env.META_ADS_CLI_APP_SECRET || process.env.META_APP_SECRET || '';

        if (appId && appSecret) {
          try {
            const url = `https://graph.facebook.com/${API_VERSION}/debug_token`
              + `?input_token=${encodeURIComponent(token)}`
              + `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
            const resp = await fetch(url);
            const json = await resp.json() as {
              data?: { expires_at?: number; data_access_expires_at?: number; scopes?: string[]; is_valid?: boolean };
            };
            const d = json.data;
            if (d) {
              (d.scopes || []).forEach((s) => grantedScopes.add(s));

              // Expiry
              if (d.expires_at && d.expires_at > 0) {
                const expMs = d.expires_at * 1000;
                const days = Math.round((expMs - Date.now()) / 86400000);
                if (days < 0) {
                  checks.push({ name: 'Token expiry', status: 'fail', detail: 'Token has expired.', fix: 'Re-authenticate: meta-ads auth login' });
                } else if (days <= 7) {
                  checks.push({ name: 'Token expiry', status: 'warn', detail: `Expires in ${days} day(s) — ${new Date(expMs).toISOString().slice(0, 10)}.`, fix: 'Refresh soon: meta-ads auth refresh-token' });
                } else {
                  checks.push({ name: 'Token expiry', status: 'ok', detail: `Expires in ${days} days (${new Date(expMs).toISOString().slice(0, 10)}).` });
                }
              } else {
                checks.push({ name: 'Token expiry', status: 'ok', detail: 'Long-lived / non-expiring token.' });
              }
            }
          } catch {
            checks.push({ name: 'Token metadata', status: 'warn', detail: 'Could not read token scopes/expiry via debug_token.' });
          }
        } else {
          checks.push({
            name: 'Token metadata',
            status: 'info',
            detail: 'App ID/Secret not set — skipping scope & expiry inspection.',
            fix: 'Set META_ADS_CLI_APP_ID and META_ADS_CLI_APP_SECRET to enable scope checks.',
          });
        }
      }

      // ── 3. Scope coverage ──────────────────────────────────────────────────
      if (grantedScopes.size > 0) {
        const missing = SCOPE_REQUIREMENTS.filter((r) => !grantedScopes.has(r.scope));
        const present = SCOPE_REQUIREMENTS.filter((r) => grantedScopes.has(r.scope));
        checks.push({
          name: 'Scopes granted',
          status: 'ok',
          detail: present.length ? present.map((p) => p.scope).join(', ') : '(none of the tracked scopes)',
        });
        for (const m of missing) {
          // ads_* missing is a hard fail; page/lead scopes are warnings (feature-specific).
          const isCore = m.scope.startsWith('ads_') || m.scope === 'read_insights';
          checks.push({
            name: `Scope: ${m.scope}`,
            status: isCore ? 'fail' : 'warn',
            detail: `Missing — needed for ${m.enables}.`,
            fix: `Regenerate the token with "${m.scope}" granted.`,
          });
        }
      }

      // ── 4. API version & deprecation posture ───────────────────────────────
      const configuredVersion = process.env.META_ADS_CLI_API_VERSION || API_VERSION;
      const major = parseMajorVersion(configuredVersion);
      if (Number.isNaN(major)) {
        checks.push({ name: 'API version', status: 'warn', detail: `Unrecognized version string "${configuredVersion}".` });
      } else if (major < MIN_SUPPORTED_VERSION) {
        checks.push({
          name: 'API version',
          status: 'fail',
          detail: `${configuredVersion} is below Meta's minimum (v${MIN_SUPPORTED_VERSION}.0) — requests will be rejected.`,
          fix: `Upgrade to v${CURRENT_VERSION}.0.`,
        });
      } else if (major < CURRENT_VERSION) {
        checks.push({
          name: 'API version',
          status: 'warn',
          detail: `${configuredVersion} is older than the current v${CURRENT_VERSION}.0.`,
          fix: `Consider upgrading to v${CURRENT_VERSION}.0.`,
        });
      } else {
        checks.push({ name: 'API version', status: 'ok', detail: `${configuredVersion} (current).` });
      }

      // ── 5. Known 2026 deprecations (informational) ─────────────────────────
      checks.push({
        name: 'Deprecation watch',
        status: 'info',
        detail: 'Legacy reach metrics retire ~Jun 2026 (→ "Views"); ASC/AAC campaign edits via API end ~May/Sep 2026; metadata=1 removed ~May 2026.',
        fix: 'Plan migrations for any legacy Advantage+ Shopping/App campaigns and reach-based reporting.',
      });

      // ── 6. Default account access + rate-limit usage ───────────────────────
      if (tokenValid && opts.accountId) {
        const client = getClient();
        try {
          const resp = await client.request(`${opts.accountId}`, {
            params: { fields: 'name,account_status,currency' },
          });
          const acct = resp.data as { name?: string; account_status?: number; currency?: string };
          const active = acct.account_status === 1;
          checks.push({
            name: 'Default account',
            status: active ? 'ok' : 'warn',
            detail: `${opts.accountId} — ${acct.name ?? '(unknown)'}${acct.currency ? `, ${acct.currency}` : ''}${active ? '' : ` (status ${acct.account_status}, not active)`}`,
          });

          // Rate-limit usage from the live response headers.
          const usage = client.getUsage();
          if (usage.peakPct > 0) {
            const status: CheckStatus = usage.peakPct >= 90 ? 'fail' : usage.peakPct >= 75 ? 'warn' : 'ok';
            checks.push({
              name: 'Rate-limit usage',
              status,
              detail: `${usage.peakPct}% of limit (${usage.detail})${usage.estimatedRecoverSec ? `, ~${Math.round(usage.estimatedRecoverSec / 60)}m to recover` : ''}.`,
              fix: status === 'ok' ? undefined : 'Slow large pulls with --page-delay; the client also auto-throttles above 75%.',
            });
          }
        } catch (err) {
          checks.push({
            name: 'Default account',
            status: 'fail',
            detail: `Cannot access ${opts.accountId}: ${(err as Error).message}`,
            fix: 'Verify the account ID and that your token has access to it.',
          });
        }
      } else if (tokenValid && !opts.accountId) {
        checks.push({
          name: 'Default account',
          status: 'info',
          detail: 'No default account set.',
          fix: 'Set META_ADS_CLI_ACCOUNT_ID or pass --account-id to test access.',
        });
      }

      // ── 7. LLM (AI features) configuration ─────────────────────────────────
      if (isLlmAvailable()) {
        checks.push({
          name: 'AI provider',
          status: 'ok',
          detail: `Configured (${llmProviderLabel()}) — "meta-ads ai recommendations" will use LLM reasoning.`,
        });
      } else {
        checks.push({
          name: 'AI provider',
          status: 'info',
          detail: 'No LLM key set — AI commands fall back to rule-based heuristics.',
          fix: 'Set ANTHROPIC_API_KEY (Claude) or META_ADS_CLI_LLM_API_KEY for LLM-backed analysis.',
        });
      }

      // ── Output ─────────────────────────────────────────────────────────────
      const fmt = (opts.output || 'text') as OutputFormat;
      if (fmt === 'text') {
        const lines: string[] = ['', 'Meta Ads CLI — Doctor', '='.repeat(60)];
        for (const c of checks) {
          lines.push(`${ICON[c.status]} ${c.name}: ${c.detail}`);
          if (c.fix && (c.status === 'fail' || c.status === 'warn' || c.status === 'info')) {
            lines.push(`    → ${c.fix}`);
          }
        }
        const fails = checks.filter((c) => c.status === 'fail').length;
        const warns = checks.filter((c) => c.status === 'warn').length;
        lines.push('='.repeat(60));
        lines.push(
          fails > 0
            ? `${fails} failure(s), ${warns} warning(s) — resolve failures before relying on the CLI.`
            : warns > 0
              ? `No failures, ${warns} warning(s).`
              : 'All checks passed. ✓',
        );
        lines.push('');
        console.log(lines.join('\n'));
        if (fails > 0) process.exitCode = 1;
      } else {
        const summary = {
          checks,
          summary: {
            ok: checks.filter((c) => c.status === 'ok').length,
            warn: checks.filter((c) => c.status === 'warn').length,
            fail: checks.filter((c) => c.status === 'fail').length,
            info: checks.filter((c) => c.status === 'info').length,
          },
        };
        console.log(formatOutput(summary, fmt));
        if (summary.summary.fail > 0) process.exitCode = 1;
      }
    }));
}
