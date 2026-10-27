export const TIME_RANGES = ['today', 'yesterday', 'last_7d', 'last_30d', 'last_90d', 'this_month', 'last_month', 'maximum'] as const;

/**
 * Resolves a named time range (e.g. 'last_7d') into a JSON-encoded
 * {since, until} string suitable for the Meta API time_range parameter.
 * Returns undefined for 'maximum' (no range). Throws on unknown names.
 *
 * Like Meta's date presets, last_Nd covers the N full days before today.
 * Dates are calendar days on the local clock.
 */
export function resolveTimeRange(timeRange: string): string | undefined {
  if (!timeRange || timeRange === 'maximum') return undefined;

  const now = new Date();
  // Format from local date parts; toISOString() would shift to UTC.
  const fmt = (d: Date) => [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
  const daysAgo = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  const lastNDays = (n: number) => ({ since: fmt(daysAgo(n)), until: fmt(daysAgo(1)) });

  const ranges: Record<string, () => { since: string; until: string }> = {
    today: () => ({ since: fmt(now), until: fmt(now) }),
    yesterday: () => ({ since: fmt(daysAgo(1)), until: fmt(daysAgo(1)) }),
    last_7d: () => lastNDays(7),
    last_30d: () => lastNDays(30),
    last_90d: () => lastNDays(90),
    this_month: () => {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { since: fmt(start), until: fmt(now) };
    },
    last_month: () => {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { since: fmt(start), until: fmt(end) };
    },
  };

  const resolver = ranges[timeRange];
  if (!resolver) {
    throw new Error(`Unknown time range "${timeRange}". Use one of: ${TIME_RANGES.join(', ')}`);
  }
  return JSON.stringify(resolver());
}

/**
 * Insights time params for a named range or explicit dates. Named ranges go
 * to Meta as date_preset, which Meta resolves in the ad account's timezone
 * (the local clock may be a different day). Explicit --since/--until win.
 */
export function insightsTimeParams(range?: string, since?: string, until?: string): Record<string, string> {
  if (since || until) {
    if (!since || !until) throw new Error('--since and --until must be used together (YYYY-MM-DD)');
    for (const d of [since, until]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid date "${d}". Use YYYY-MM-DD.`);
    }
    return { time_range: JSON.stringify({ since, until }) };
  }
  if (!range) return {};
  if (!(TIME_RANGES as readonly string[]).includes(range)) {
    throw new Error(`Unknown time range "${range}". Use one of: ${TIME_RANGES.join(', ')}`);
  }
  return { date_preset: range };
}
