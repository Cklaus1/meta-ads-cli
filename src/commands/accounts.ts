import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { resolveProfile } from '../profiles.js';
import { deriveMetrics, PERFORMANCE_FIELDS } from '../metrics.js';
import { insightsTimeParams } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

function actId(id: string): string {
  return id.startsWith('act_') ? id : `act_${id}`;
}

// From the AdAccount reference (checked 2026-10-27).
export const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};
export const DISABLE_REASON: Record<number, string> = {
  0: 'NONE', 1: 'ADS_INTEGRITY_POLICY', 2: 'ADS_IP_REVIEW', 3: 'RISK_PAYMENT', 4: 'GRAY_ACCOUNT_SHUT_DOWN',
  5: 'ADS_AFC_REVIEW', 6: 'BUSINESS_INTEGRITY_RAR', 7: 'PERMANENT_CLOSE', 8: 'UNUSED_RESELLER_ACCOUNT',
  9: 'UNUSED_ACCOUNT', 10: 'UMBRELLA_AD_ACCOUNT', 11: 'BUSINESS_MANAGER_INTEGRITY_POLICY',
  12: 'MISREPRESENTED_AD_ACCOUNT', 13: 'AOAB_DESHARE_LEGAL_ENTITY', 14: 'CTX_THREAD_REVIEW', 15: 'COMPROMISED_AD_ACCOUNT',
};

export interface HealthIssue { severity: 'blocker' | 'warning' | 'info'; issue: string; fix?: string }

/**
 * Turn account fields, ad volume and disapproved-ad counts into a list of
 * reasons the account may not deliver. Money fields are in the account's
 * minor units (cents for USD), as Meta returns them.
 */
export function assessAccountHealth(
  account: Record<string, unknown>,
  extra: { adsRunning?: number; adsLimit?: number; disapprovedAds?: number } = {},
): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const status = Number(account.account_status);
  if (status && status !== 1) {
    const reason = DISABLE_REASON[Number(account.disable_reason)] || String(account.disable_reason ?? '');
    issues.push({
      severity: 'blocker',
      issue: `Account status is ${ACCOUNT_STATUS[status] || status}${reason && reason !== 'NONE' ? ` (disable reason: ${reason})` : ''}.`,
      fix: status === 3 || status === 8 || status === 9
        ? 'Settle the outstanding balance in Billing & payments.'
        : 'Check Account Quality (business.facebook.com/accountquality) to review or appeal.',
    });
  }
  if (!account.funding_source && status === 1) {
    issues.push({ severity: 'blocker', issue: 'No payment method on file; ads can be created but won\'t deliver.', fix: 'Add a payment method in Billing & payments.' });
  }
  const cap = Number(account.spend_cap);
  const spent = Number(account.amount_spent);
  if (cap > 0) {
    const pct = (spent / cap) * 100;
    if (pct >= 100) issues.push({ severity: 'blocker', issue: `Account spend cap reached (${spent} of ${cap}).`, fix: 'Raise or reset the cap: meta-ads accounts set-spend-cap' });
    else if (pct >= 90) issues.push({ severity: 'warning', issue: `Account spend cap ${pct.toFixed(0)}% used (${spent} of ${cap}).`, fix: 'Raise or reset the cap before delivery stops.' });
  }
  if (Number(account.balance) > 0 && account.is_prepay_account) {
    issues.push({ severity: 'info', issue: `Prepay account balance due: ${account.balance}.` });
  }
  if (extra.adsLimit && extra.adsRunning !== undefined && extra.adsRunning >= extra.adsLimit * 0.9) {
    issues.push({
      severity: extra.adsRunning >= extra.adsLimit ? 'blocker' : 'warning',
      issue: `${extra.adsRunning} ads running or in review (limit ${extra.adsLimit}). At the limit, new ads don't publish.`,
      fix: 'Pause or archive unused ads.',
    });
  }
  if (extra.disapprovedAds) {
    issues.push({ severity: 'warning', issue: `${extra.disapprovedAds} ad(s) disapproved or with issues.`, fix: 'Review them with meta-ads ads list --effective-status DISAPPROVED, then fix or request review.' });
  }
  return issues;
}

/** Days in the month of a date, and how many have fully elapsed. */
function monthProgress(now: Date): { daysInMonth: number; daysElapsed: number } {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return { daysInMonth, daysElapsed: Math.max(1, now.getDate() - 1) };
}

export function registerAccountCommands(program: Command, getClient: () => MetaClient): void {
  const accounts = program.command('accounts').description('Ad account management');

  accounts
    .command('list')
    .description('List ad accounts accessible by current user')
    .option('--limit <n>', 'Maximum number of accounts', '200')
    .option('--user-id <id>', 'User ID (default: me)', 'me')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format: json, table, csv, text, yaml', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,account_id,account_status,amount_spent,balance,currency,age,business_city,business_country_code',
        limit: opts.limit,
      };

      const endpoint = `${opts.userId}/adaccounts`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  accounts
    .command('get <accountId>')
    .description('Get detailed info for a specific ad account')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (accountId: string, opts) => {
      const client = getClient();
      // Ensure act_ prefix
      const id = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
      const params: Record<string, string> = {
        fields: 'id,name,account_id,account_status,amount_spent,balance,currency,age,business_city,business_country_code,timezone_name,spend_cap,funding_source_details',
      };

      const response = await client.request(id, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  accounts
    .command('activity <accountId>')
    .description('Get activity log (audit trail) for an ad account')
    .option('--limit <n>', 'Maximum entries', '25')
    .option('--since <timestamp>', 'Start Unix timestamp')
    .option('--until <timestamp>', 'End Unix timestamp')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (accountId: string, opts) => {
      const client = getClient();
      const id = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
      const params: Record<string, string> = {
        fields: 'actor_id,actor_name,event_type,event_time,extra_data,object_id,object_name,translated_event_type',
        limit: opts.limit,
      };
      if (opts.since) params.since = opts.since;
      if (opts.until) params.until = opts.until;

      const endpoint = `${id}/activities`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  accounts
    .command('health <accountId>')
    .description('Why might this account not deliver? Status, disable reason, payment method, spend cap, ad volume limit and disapproved ads')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (accountId: string, opts) => {
      const client = getClient();
      const id = actId(accountId);
      const account = (await client.request(id, {
        params: { fields: 'id,name,account_status,disable_reason,currency,spend_cap,amount_spent,balance,min_daily_budget,funding_source,funding_source_details,is_prepay_account,timezone_name' },
      })).data as Record<string, unknown>;

      // Ad volume and disapproved ads are best-effort: either call can fail
      // on accounts without the needed permission.
      let adsRunning: number | undefined;
      let adsLimit: number | undefined;
      try {
        const vol = (await client.request(`${id}/ads_volume`, {})).data as { data?: Array<Record<string, unknown>> };
        const row = vol.data?.[0];
        if (row) {
          adsRunning = Number(row.ads_running_or_in_review_count);
          if (row.limit_on_ads_running_or_in_review !== undefined) adsLimit = Number(row.limit_on_ads_running_or_in_review);
        }
      } catch { /* not available */ }
      let disapprovedAds: number | undefined;
      try {
        const ads = (await client.request(`${id}/ads`, {
          params: {
            fields: 'id',
            limit: '1',
            summary: 'total_count',
            filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['DISAPPROVED', 'WITH_ISSUES'] }]),
          },
        })).data as { summary?: { total_count?: number } };
        disapprovedAds = ads.summary?.total_count;
      } catch { /* not available */ }

      const issues = assessAccountHealth(account, { adsRunning, adsLimit, disapprovedAds });
      console.log(formatOutput({
        account_id: id,
        name: account.name,
        status: ACCOUNT_STATUS[Number(account.account_status)] ?? account.account_status,
        disable_reason: DISABLE_REASON[Number(account.disable_reason)] ?? account.disable_reason,
        currency: account.currency,
        spend_cap: account.spend_cap,
        amount_spent: account.amount_spent,
        min_daily_budget: account.min_daily_budget,
        ads_running_or_in_review: adsRunning ?? null,
        disapproved_ads: disapprovedAds ?? null,
        healthy: !issues.some(i => i.severity === 'blocker'),
        issues,
      }, opts.output as OutputFormat));
      if (issues.some(i => i.severity === 'blocker')) process.exitCode = 1;
    }));

  accounts
    .command('set-spend-cap <accountId>')
    .description('Set, reset or remove the account-level spend cap (Meta pauses all delivery once amount spent reaches it)')
    .option('--cents <amount>', 'New cap in the account currency\'s minor units (cents for USD)')
    .option('--reset', 'Reset amount spent against the cap back to 0')
    .option('--remove', 'Remove the spend cap')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (accountId: string, opts) => {
      const chosen = [opts.cents !== undefined, !!opts.reset, !!opts.remove].filter(Boolean).length;
      if (chosen !== 1) throw new Error('Give exactly one of --cents <amount>, --reset or --remove');
      const body: Record<string, string> = {};
      if (opts.cents !== undefined) {
        if (!/^\d+$/.test(String(opts.cents)) || Number(opts.cents) <= 0) {
          throw new Error(`--cents must be a positive whole number, got: "${opts.cents}"`);
        }
        // Sent in minor units like the read field; the CLI's spend-cap guard checks it too.
        body.spend_cap = String(opts.cents);
      } else {
        body.spend_cap_action = opts.reset ? 'reset' : 'delete';
      }
      const response = await getClient().request(actId(accountId), { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  accounts
    .command('spend <accountId>')
    .description('Spend pacing: month-to-date spend, daily average, projected month-end, and room left under the account spend cap')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (accountId: string, opts) => {
      const client = getClient();
      const id = actId(accountId);
      const account = (await client.request(id, { params: { fields: 'currency,spend_cap,amount_spent,timezone_name' } })).data as Record<string, unknown>;
      // date_preset resolves in the account's timezone.
      const [mtd, yesterday] = await Promise.all([
        client.request(`${id}/insights`, { params: { fields: 'spend', date_preset: 'this_month' } }),
        client.request(`${id}/insights`, { params: { fields: 'spend', date_preset: 'yesterday' } }),
      ]);
      const spendOf = (r: { data: unknown }) => Number((((r.data as { data?: Array<{ spend?: string }> }).data) || [])[0]?.spend ?? 0);
      const monthSpend = spendOf(mtd);
      const { daysInMonth, daysElapsed } = monthProgress(new Date());
      const dailyAvg = monthSpend / daysElapsed;
      const cap = Number(account.spend_cap);
      const spent = Number(account.amount_spent);
      const capRemaining = cap > 0 ? cap - spent : null;
      console.log(formatOutput({
        account_id: id,
        currency: account.currency,
        timezone: account.timezone_name,
        month_to_date_spend: monthSpend,
        yesterday_spend: spendOf(yesterday),
        daily_average: Number(dailyAvg.toFixed(2)),
        projected_month_end: Number((dailyAvg * daysInMonth).toFixed(2)),
        spend_cap_minor_units: cap > 0 ? cap : null,
        amount_spent_minor_units: spent,
        cap_remaining_minor_units: capRemaining,
        // amount_spent/spend_cap are in minor units; insights spend is in major units.
        days_until_cap_at_current_pace: capRemaining !== null && dailyAvg > 0 ? Number((capRemaining / 100 / dailyAvg).toFixed(1)) : null,
        note: 'Insights spend is in currency units; spend_cap and amount_spent are in minor units (cents for USD). Days-until-cap assumes a 2-decimal currency.',
      }, opts.output as OutputFormat));
    }));

  accounts
    .command('rollup')
    .description('Roll up spend, results, revenue and ROAS across several ad accounts or profiles')
    .option('--accounts <ids>', 'Comma-separated ad account IDs (uses the current token)')
    .option('--profiles <names>', 'Comma-separated profile names (each profile\'s token and default account)')
    .option('--time-range <range>', 'today, yesterday, last_7d, last_30d, last_90d, this_month, last_month, maximum', 'last_7d')
    .option('--since <date>', 'Start date YYYY-MM-DD (with --until)')
    .option('--until <date>', 'End date YYYY-MM-DD (with --since)')
    .option('--result-event <event>', 'Conversion counted as a result (purchase, lead, ...)', 'purchase')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const targets: Array<{ account: string; label: string; token?: string }> = [];
      for (const a of String(opts.accounts || '').split(',').map((x: string) => x.trim()).filter(Boolean)) {
        targets.push({ account: actId(a), label: actId(a) });
      }
      for (const name of String(opts.profiles || '').split(',').map((x: string) => x.trim()).filter(Boolean)) {
        const profile = await resolveProfile(name);
        if (!profile) throw new Error(`Profile "${name}" not found`);
        if (!profile.accountId) throw new Error(`Profile "${name}" has no default account`);
        targets.push({ account: actId(profile.accountId), label: name, token: profile.accessToken });
      }
      if (targets.length === 0) throw new Error('Give --accounts and/or --profiles');

      const client = getClient();
      const time = insightsTimeParams(opts.timeRange, opts.since, opts.until);
      const rows: Array<Record<string, unknown>> = [];
      for (const t of targets) {
        const [acct, ins] = await Promise.all([
          client.request(t.account, { params: { fields: 'name,currency' }, accessToken: t.token }),
          client.request(`${t.account}/insights`, { params: { fields: PERFORMANCE_FIELDS, ...time }, accessToken: t.token }),
        ]);
        const row = (((ins.data as { data?: Array<Record<string, unknown>> }).data) || [])[0] || {};
        const m = deriveMetrics(row, opts.resultEvent);
        const info = acct.data as Record<string, unknown>;
        rows.push({ source: t.label, account_id: t.account, name: info.name, currency: info.currency, ...m });
      }
      console.log(formatOutput(rollupAccounts(rows), opts.output as OutputFormat));
    }));
}

/** Per-account rows plus totals; totals are only summed when currencies match. */
export function rollupAccounts(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const currencies = [...new Set(rows.map(r => r.currency).filter(Boolean))];
  const sum = (k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const spend = sum('spend');
  const results = sum('results');
  const revenue = sum('revenue');
  const totals = currencies.length > 1 ? null : {
    currency: currencies[0] ?? null,
    spend: Number(spend.toFixed(2)),
    impressions: sum('impressions'),
    clicks: sum('clicks'),
    results,
    cost_per_result: results > 0 ? Number((spend / results).toFixed(2)) : null,
    revenue: Number(revenue.toFixed(2)),
    roas: spend > 0 && revenue > 0 ? Number((revenue / spend).toFixed(2)) : null,
  };
  return {
    accounts: rows,
    totals,
    ...(totals ? {} : { note: `Accounts use different currencies (${currencies.join(', ')}), so totals aren't summed.` }),
  };
}
