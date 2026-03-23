/**
 * Resolves a named time range (e.g. 'last_7d') into a JSON-encoded
 * {since, until} string suitable for the Meta API time_range parameter.
 * Returns undefined for 'maximum' or unrecognized values.
 */
export function resolveTimeRange(timeRange: string): string | undefined {
  if (!timeRange || timeRange === 'maximum') return undefined;

  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const ranges: Record<string, () => { since: string; until: string }> = {
    today: () => ({ since: fmt(now), until: fmt(now) }),
    yesterday: () => {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { since: fmt(d), until: fmt(d) };
    },
    last_7d: () => {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { since: fmt(d), until: fmt(now) };
    },
    last_30d: () => {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { since: fmt(d), until: fmt(now) };
    },
    last_90d: () => {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return { since: fmt(d), until: fmt(now) };
    },
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
  return resolver ? JSON.stringify(resolver()) : undefined;
}
