// T048 Phase 2 — topic_clusters: dynamic topic aggregation + utility-based active_weight.
//
// Pure functions (unit-tested in test/topic-clusters-unit.mjs). The LanceDB-backed
// TopicClusters manager (dynamic upsert + GUARD) is implemented in 4b and consumes
// these helpers. No hardcoded topic list — topics are born on first appearance.

/** Logistic squashing function. Bounded in (0,1); sigmoid(0) = 0.5 (cold-start). */
export function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Deterministic topic-key normalization. Lowercase, trim, non-[a-z0-9_] runs → "_",
 * sliced to 32 chars. Used to build stable `scope::normalized` topic ids.
 */
export function normalizeTopicKey(raw: string | null | undefined): string {
  if (!raw) return "uncategorized";
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 32);
}

export interface ActiveWeightFeatures {
  hit_rate: number;
  recent_hits: number;
  avg_answer_gain: number;
  importance_mean: number;
}

export interface ActiveWeightWeights {
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * Utility-based active_weight (NOT raw frequency). Grows from answer helpfulness.
 * x = a*hit_rate + b*recent_hits + c*avg_answer_gain + d*importance_mean; return sigmoid(x).
 */
export function computeActiveWeight(
  f: ActiveWeightFeatures,
  w: ActiveWeightWeights,
): number {
  const x =
    w.a * (f.hit_rate || 0) +
    w.b * (f.recent_hits || 0) +
    w.c * (f.avg_answer_gain || 0) +
    w.d * (f.importance_mean || 0);
  return sigmoid(x);
}

// ============================================================================
// TopicClusters — dynamic topic aggregation layer (T048 Phase 2)
// ============================================================================
// No hardcoded topic list: a topic is born on first appearance in memory
// metadata. active_weight is utility-based (grows from answer helpfulness, not
// raw frequency). GUARD (norm/prune/cap) keeps the table bounded.

/** Minimal structural subset of a LanceDB Table used by TopicClusters. */
export interface TopicClusterQuery {
  where(sql: string): TopicClusterQuery;
  limit(n: number): { toArray(): Promise<Record<string, unknown>[]> };
}
export interface TopicClusterTable {
  query(): TopicClusterQuery;
  add(rows: Record<string, unknown>[]): Promise<unknown>;
  delete(where: string): Promise<unknown>;
}

export interface TopicClustersOptions {
  /** Startup active_weight weights (calibrated in Phase 3). */
  weights?: ActiveWeightWeights;
  /** Prune topics older than this many days with low weight + low doc count. */
  pruneAfterDays?: number;
  /** Max active topics per scope before oldest low-weight ones are archived. */
  maxActiveTopics?: number;
}

const DEFAULT_WEIGHTS: ActiveWeightWeights = { a: 0.4, b: 0.3, c: 0.2, d: 0.1 };

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export class TopicClusters {
  private table: TopicClusterTable;
  private weights: ActiveWeightWeights;
  private pruneAfterDays: number;
  private maxActiveTopics: number;

  constructor(table: TopicClusterTable, options: TopicClustersOptions = {}) {
    this.table = table;
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.pruneAfterDays = options.pruneAfterDays ?? 90;
    this.maxActiveTopics = options.maxActiveTopics ?? 200;
  }

  /** Build a deterministic topic id from scope + normalized topic. */
  static topicId(scope: string, topic: string): string {
    return `${scope}::${normalizeTopicKey(topic)}`;
  }

  private featuresFromRow(row: Record<string, unknown>): ActiveWeightFeatures {
    return {
      hit_rate: Number(row.hit_rate) || 0,
      recent_hits: Number(row.recent_hits) || 0,
      avg_answer_gain: Number(row.avg_answer_gain) || 0,
      importance_mean: Number(row.importance_mean) || 0,
    };
  }

  /** Dynamic upsert: create on first appearance, update aggregates on repeat. */
  async upsertTopic(input: {
    topicId: string;
    scope: string;
    vector: number[];
    importance: number;
    confidence?: number;
  }): Promise<void> {
    const { topicId, scope, vector, importance, confidence = 0.5 } = input;
    const existing = await this.readRow(topicId);

    if (!existing) {
      // §8b.4 / §5.4: cold-start seed = sigmoid(0) = 0.5 (independent of importance).
      const row = this.buildRow({
        topicId,
        scope,
        vector,
        importance,
        confidence,
        docCount: 1,
        hitRate: 0,
        recentHits: 0,
        avgAnswerGain: 0,
        activeWeight: sigmoid(0),
        status: "active",
      });
      await this.table.add([row]);
      return;
    }

    const prevCount = Number(existing.doc_count) || 1;
    const docCount = prevCount + 1;
    // Rolling mean for importance / confidence.
    const prevImp = Number(existing.importance_mean) || 0;
    const importanceMean = (prevImp * prevCount + importance) / docCount;
    const prevConf = Number(existing.avg_confidence) || 0;
    const avgConfidence = (prevConf * prevCount + confidence) / docCount;
    // Exponential smoothing for the centroid vector.
    const prevVec = (existing.vector as number[]) || vector;
    const alpha = 1 / docCount;
    const centroid = prevVec.map((v, i) => v + alpha * ((vector[i] || 0) - v));

    const row = this.buildRow({
      topicId,
      scope,
      vector: centroid,
      importance: importanceMean,
      confidence: avgConfidence,
      docCount,
      hitRate: Number(existing.hit_rate) || 0,
      recentHits: Number(existing.recent_hits) || 0,
      avgAnswerGain: Number(existing.avg_answer_gain) || 0,
      // Update: recompute utility weight from rolling features (§6).
      activeWeight: computeActiveWeight(
        {
          hit_rate: Number(existing.hit_rate) || 0,
          recent_hits: Number(existing.recent_hits) || 0,
          avg_answer_gain: Number(existing.avg_answer_gain) || 0,
          importance_mean: importanceMean,
        },
        this.weights,
      ),
      status: "active",
    });
    await this.table.delete(`topic_id = '${escapeSqlLiteral(topicId)}'`);
    await this.table.add([row]);
  }

  /** active_weight for a topic (0 if unknown). Used by the retriever boost. */
  async getActiveWeight(topicId: string, _scope: string): Promise<number> {
    const row = await this.readRow(topicId);
    if (!row) return 0;
    if (row.status === "archived" || row.status === "dormant") return 0;
    // Return the stored, already-computed weight (seed 0.5 at cold-start per
    // §8b.4; recomputed on each upsert per §6). Do NOT recompute from features
    // here — that would override the cold-start seed with sigmoid(d·importance).
    return Number(row.active_weight) || 0;
  }

  private async readRow(topicId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.table
      .query()
      .where(`topic_id = '${escapeSqlLiteral(topicId)}'`)
      .limit(1)
      .toArray();
    return rows[0] ?? null;
  }

  private buildRow(p: {
    topicId: string;
    scope: string;
    vector: number[];
    importance: number;
    confidence: number;
    docCount: number;
    hitRate: number;
    recentHits: number;
    avgAnswerGain: number;
    activeWeight: number;
    status: string;
  }): Record<string, unknown> {
    return {
      topic_id: p.topicId,
      scope: p.scope,
      topic: p.topicId.split("::")[1] ?? p.topicId,
      vector: p.vector,
      doc_count: p.docCount,
      hit_count: 0,
      hit_rate: p.hitRate,
      recent_hits: p.recentHits,
      avg_answer_gain: p.avgAnswerGain,
      last_hit_ts: Date.now(),
      avg_importance: p.importance,
      importance_mean: p.importance,
      avg_confidence: p.confidence,
      active_weight: p.activeWeight,
      decay_rate: 0.01,
      status: p.status,
      metadata: JSON.stringify({ subtopics: [], recent_hits: [], answer_gain_sum: 0 }),
    };
  }
}

