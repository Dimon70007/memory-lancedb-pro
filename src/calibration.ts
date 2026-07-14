// T048-4f: calibration harness on recall_log (spec §6, §9.3, Gate D).
// This module is the Phase-3 handoff artifact: it computes the metrics needed
// to calibrate weights (α..θ) from real recall_log data. It does NOT flip the
// clusterBoostEnabled default — that decision is gated on Gate D (real data).
//
// Design notes:
// - avg_answer_gain (§6 c-term) = sum(user_feedback where not null) / count(used_in_answer).
// - active_weight (§6) = sigmoid(a·hit_rate + b·recent_hits + c·avg_answer_gain + d·importance_mean).
// - Gate D: pass iff avg_answer_gain >= baseline AND no critical-fact regression.
// - tuneParameters: grid search over (θ, a, b, c, d) maximizing mean rank-gain of
//   used_in_answer candidates under re-scored scores, subject to no critical regression.

export interface RecallLogRow {
  query_id: string;
  session_key: string;
  query_text: string;
  candidate_id: string;
  topic_id: string | null;
  score_raw: number;
  score_final: number;
  used_in_answer: boolean;
  user_feedback: number | null;
  recall_ts: number;
  metadata: string;
}

export interface TopicClusterRow {
  topic_id: string;
  scope: string;
  doc_count: number;
  hit_count: number;
  last_hit_ts: number;
  avg_importance: number;
  avg_confidence: number;
  active_weight: number;
  decay_rate: number;
  status: string;
  metadata: string;
}

export interface CalibrationParams {
  theta: number;
  a: number;
  b: number;
  c: number;
  d: number;
}

export const DEFAULT_CALIBRATION: CalibrationParams = {
  theta: 0.08,
  a: 0.4,
  b: 0.3,
  c: 0.2,
  d: 0.1,
};

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * §6 c-term: avg_answer_gain = sum(user_feedback where not null) / count(used_in_answer).
 * Returns 0 when there are no used_in_answer rows (nothing to learn from yet).
 */
export function computeAvgAnswerGain(rows: RecallLogRow[]): number {
  const used = rows.filter((r) => r.used_in_answer);
  if (used.length === 0) return 0;
  const feedbackSum = used.reduce((s, r) => s + (r.user_feedback ?? 0), 0);
  return feedbackSum / used.length;
}

export interface TopicStats {
  topic_id: string;
  hit_rate: number; // used_in_answer / total recalls of this topic
  recent_hits: number; // recalls within the recent window
  avg_answer_gain: number; // per-topic c-term
  importance_mean: number; // from topic_clusters.avg_importance
}

export function computeTopicStats(
  rows: RecallLogRow[],
  topics: Map<string, TopicClusterRow>,
  now: number,
  recentWindowMs: number = 7 * 24 * 3600 * 1000,
): TopicStats[] {
  const byTopic = new Map<string, RecallLogRow[]>();
  for (const r of rows) {
    if (!r.topic_id) continue;
    const arr = byTopic.get(r.topic_id);
    if (arr) arr.push(r);
    else byTopic.set(r.topic_id, [r]);
  }
  const out: TopicStats[] = [];
  for (const [topicId, trows] of byTopic) {
    const used = trows.filter((r) => r.used_in_answer);
    const hit_rate = trows.length > 0 ? used.length / trows.length : 0;
    const recent_hits = trows.filter((r) => now - r.recall_ts <= recentWindowMs).length;
    const avg_answer_gain = used.length > 0
      ? used.reduce((s, r) => s + (r.user_feedback ?? 0), 0) / used.length
      : 0;
    const topic = topics.get(topicId);
    const importance_mean = topic ? topic.avg_importance : 0;
    out.push({ topic_id: topicId, hit_rate, recent_hits, avg_answer_gain, importance_mean });
  }
  return out;
}

/** §6: active_weight = sigmoid(a·hit_rate + b·recent_hits + c·avg_answer_gain + d·importance_mean). */
export function computeActiveWeight(stats: TopicStats, p: CalibrationParams): number {
  const x = p.a * stats.hit_rate + p.b * stats.recent_hits + p.c * stats.avg_answer_gain + p.d * stats.importance_mean;
  return sigmoid(x);
}

/**
 * Gate D regression check: a critical fact regresses if it was demoted by the boost —
 * i.e. it is NOT used_in_answer AND its score_final dropped below score_raw.
 * (A critical fact that stays used, or that the boost helped, is fine.)
 */
export function detectCriticalRegression(rows: RecallLogRow[], criticalIds: Set<string>): boolean {
  return rows.some(
    (r) => criticalIds.has(r.candidate_id) && r.used_in_answer === false && r.score_final < r.score_raw,
  );
}

export interface GateResult {
  pass: boolean;
  avgAnswerGain: number;
  baseline: number;
  regression: boolean;
  recommendedParams: CalibrationParams;
}

/**
 * Gate D decision (spec §9 acceptance + debate gate conditions):
 * pass iff avg_answer_gain >= baseline AND no critical-fact regression.
 * The default flip to ON is gated on this passing on REAL recall_log data (Phase 3).
 */
export function evaluateGate(opts: {
  rows: RecallLogRow[];
  baseline: number;
  criticalIds: Set<string>;
  params?: CalibrationParams;
}): GateResult {
  const params = opts.params ?? DEFAULT_CALIBRATION;
  const avgAnswerGain = computeAvgAnswerGain(opts.rows);
  const regression = detectCriticalRegression(opts.rows, opts.criticalIds);
  const pass = avgAnswerGain >= opts.baseline && !regression;
  return { pass, avgAnswerGain, baseline: opts.baseline, regression, recommendedParams: params };
}

/**
 * Simulate re-scoring with given params: score_final' = score_raw + θ·active_weight(topic).
 * Used by tuneParameters to estimate the effect of candidate weights without re-running retrieval.
 */
export function simulateRescore(
  rows: RecallLogRow[],
  topics: Map<string, TopicClusterRow>,
  params: CalibrationParams,
  now: number,
): RecallLogRow[] {
  const statsMap = new Map(computeTopicStats(rows, topics, now).map((s) => [s.topic_id, s] as const));
  return rows.map((r) => {
    if (!r.topic_id) return { ...r };
    const stats = statsMap.get(r.topic_id);
    if (!stats) return { ...r };
    const aw = computeActiveWeight(stats, params);
    const score_final = r.score_raw + params.theta * aw;
    return { ...r, score_final };
  });
}

/** Mean rank improvement (raw rank − final rank) of used_in_answer candidates, per query group. Positive = boost promoted the used answer. */
export function meanUsedRankGain(rescored: RecallLogRow[]): number {
  const byQuery = new Map<string, RecallLogRow[]>();
  for (const r of rescored) {
    const q = r.query_id.split("::")[0];
    const arr = byQuery.get(q);
    if (arr) arr.push(r);
    else byQuery.set(q, [r]);
  }
  let sum = 0;
  let n = 0;
  for (const group of byQuery.values()) {
    const rawRanks = rank(group, (r) => r.score_raw);
    const finalRanks = rank(group, (r) => r.score_final);
    for (const r of group) {
      if (!r.used_in_answer) continue;
      sum += rawRanks.get(r.candidate_id)! - finalRanks.get(r.candidate_id)!;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function rank(rows: RecallLogRow[], scoreFn: (r: RecallLogRow) => number): Map<string, number> {
  const sorted = [...rows].sort((a, b) => scoreFn(b) - scoreFn(a));
  const m = new Map<string, number>();
  sorted.forEach((r, i) => m.set(r.candidate_id, i + 1));
  return m;
}

/**
 * Grid search over (θ, a, b, c, d) maximizing meanUsedRankGain of used_in_answer
 * candidates, subject to NO critical-fact regression. Returns the best params found.
 * This is the Phase-3 tuning entry point; call it on real recall_log once the sink
 * is wired and used_in_answer / user_feedback are populated post-hoc.
 */
export function tuneParameters(opts: {
  rows: RecallLogRow[];
  topics: Map<string, TopicClusterRow>;
  baseline: number;
  criticalIds: Set<string>;
  now: number;
  thetaGrid?: number[];
  aGrid?: number[];
  bGrid?: number[];
  cGrid?: number[];
  dGrid?: number[];
}): CalibrationParams {
  const thetaGrid = opts.thetaGrid ?? [0.04, 0.08, 0.12];
  const aGrid = opts.aGrid ?? [0.3, 0.4, 0.5];
  const bGrid = opts.bGrid ?? [0.2, 0.3, 0.4];
  const cGrid = opts.cGrid ?? [0.1, 0.2, 0.3];
  const dGrid = opts.dGrid ?? [0.05, 0.1, 0.15];
  let best: CalibrationParams = { ...DEFAULT_CALIBRATION };
  let bestGain = -Infinity;
  for (const theta of thetaGrid) {
    for (const a of aGrid) {
      for (const b of bGrid) {
        for (const c of cGrid) {
          for (const d of dGrid) {
            const params: CalibrationParams = { theta, a, b, c, d };
            const rescored = simulateRescore(opts.rows, opts.topics, params, opts.now);
            if (detectCriticalRegression(rescored, opts.criticalIds)) continue;
            const gain = meanUsedRankGain(rescored);
            if (gain > bestGain) {
              bestGain = gain;
              best = params;
            }
          }
        }
      }
    }
  }
  return best;
}
