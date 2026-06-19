/**
 * Benchmark / context layer.
 *
 * Raw numbers aren't insight — a $0.45 CPM means nothing without knowing the
 * account's own distribution. This module computes account-relative baselines
 * (medians + spread) and a per-platform breakdown so downstream analysis (the
 * LLM, or rule-based fallbacks) can say "good/bad" with a reference point.
 */

export interface MetricStats {
  median: number;
  mean: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  count: number;
}

export interface Benchmarks {
  /** Per-metric distribution across the analyzed entities. */
  metrics: Record<string, MetricStats>;
  /** Total spend across analyzed entities (dollars). */
  total_spend: number;
  /** Number of entities with delivery. */
  active_entities: number;
}

function stats(values: number[]): MetricStats {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { median: 0, mean: 0, min: 0, max: 0, p25: 0, p75: 0, count: 0 };
  const q = (p: number) => v[Math.min(n - 1, Math.floor(p * n))];
  const mean = v.reduce((a, b) => a + b, 0) / n;
  return {
    median: q(0.5),
    mean: Number(mean.toFixed(4)),
    min: v[0],
    max: v[n - 1],
    p25: q(0.25),
    p75: q(0.75),
    count: n,
  };
}

const METRICS = ['ctr', 'cpc', 'cpm', 'frequency', 'spend'];

/**
 * Compute distribution stats over a set of insight rows (one per entity).
 * Only rows with non-zero impressions are considered "active".
 */
export function computeBenchmarks(rows: Array<Record<string, unknown>>): Benchmarks {
  const active = rows.filter((r) => parseFloat(String(r.impressions || 0)) > 0);
  const metrics: Record<string, MetricStats> = {};
  for (const m of METRICS) {
    metrics[m] = stats(active.map((r) => parseFloat(String(r[m] || 0))));
  }
  const total_spend = active.reduce((s, r) => s + parseFloat(String(r.spend || 0)), 0);
  return {
    metrics,
    total_spend: Number(total_spend.toFixed(2)),
    active_entities: active.length,
  };
}

/**
 * Classify a single metric value against the account distribution.
 * Returns a label and how many IQRs from the median (signed).
 */
export function classify(value: number, s: MetricStats, lowerIsBetter: boolean): {
  label: 'excellent' | 'good' | 'average' | 'poor' | 'unknown';
  vsMedian: string;
} {
  if (s.count < 3 || !Number.isFinite(value)) return { label: 'unknown', vsMedian: 'n/a' };
  const pct = s.median !== 0 ? ((value - s.median) / s.median) * 100 : 0;
  const vsMedian = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs median`;
  // For "lower is better" metrics (cpc, cpm), below-median is good.
  const better = lowerIsBetter ? value <= s.p25 : value >= s.p75;
  const worse = lowerIsBetter ? value >= s.p75 : value <= s.p25;
  if (better) return { label: value === (lowerIsBetter ? s.min : s.max) ? 'excellent' : 'good', vsMedian };
  if (worse) return { label: 'poor', vsMedian };
  return { label: 'average', vsMedian };
}

export const LOWER_IS_BETTER = new Set(['cpc', 'cpm', 'frequency']);
