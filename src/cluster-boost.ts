// T048-9: SOLID extraction of the cluster_boost scoring logic.
//
// SRP : boost scoring is isolated from the retriever (no boost math in retrieve()).
// OCP : `ScoreBoost` interface lets new boost strategies be added without
//       modifying the retriever — the retriever is open for extension.
// DIP : the retriever depends on the `ScoreBoost` abstraction, not a concrete
//       boost implementation; the host injects the strategy (e.g. via DI).
//
// The default strategy uses a `TopicClusterProvider` (utility-based active_weight)
// and adds `theta * active_weight(topicId)` to each candidate score, immediately
// after rerank and before recency/decay/diversity (per T048 design §7/§9.4).
import type { RetrievalResult } from "./retriever.js";
import type { TopicClusterProvider } from "./retriever.js";
import { parseSmartMetadata } from "./smart-metadata.js";

/** Context the retriever passes to a boost strategy. */
export interface BoostContext {
  clusterBoostEnabled: boolean;
  clusterBoostTheta: Record<string, number>;
}

/**
 * Abstraction for a score-boost strategy. Implementations mutate candidate
 * scores in place (setting scoreRaw/scoreFinal snapshots) and return the array.
 * New strategies (e.g. time-decay boost, diversity boost) implement this without
 * touching the retriever — that is the OCP guarantee.
 */
export interface ScoreBoost {
  boost(candidates: RetrievalResult[], ctx: BoostContext): Promise<RetrievalResult[]>;
}

export interface ClusterBoostStrategyOptions {
  provider: TopicClusterProvider;
  defaultTheta?: number;
}

/**
 * Default cluster_boost strategy. Reads each candidate's `parent_topic_id`
 * (from smart metadata), looks up the topic's utility-based active_weight via
 * the injected `TopicClusterProvider`, and adds `theta * active_weight`.
 */
export class ClusterBoostStrategy implements ScoreBoost {
  private provider: TopicClusterProvider;
  private defaultTheta: number;

  constructor(provider: TopicClusterProvider, defaultTheta = 0.08) {
    this.provider = provider;
    this.defaultTheta = defaultTheta;
  }

  async boost(
    candidates: RetrievalResult[],
    ctx: BoostContext,
  ): Promise<RetrievalResult[]> {
    // Snapshot pre/post scores for recall_log (§4: score_raw vs score_final).
    for (const candidate of candidates) {
      candidate.scoreRaw = candidate.score;
      candidate.scoreFinal = candidate.score;
    }
    if (!ctx.clusterBoostEnabled) return candidates;

    const thetaMap =
      ctx.clusterBoostTheta && Object.keys(ctx.clusterBoostTheta).length > 0
        ? ctx.clusterBoostTheta
        : { default: this.defaultTheta };

    for (const candidate of candidates) {
      const metadata = parseSmartMetadata(
        candidate.entry.metadata,
        candidate.entry,
      ) as Record<string, unknown>;
      const topicId = metadata?.parent_topic_id;
      if (typeof topicId !== "string" || !topicId) continue;
      const scope = candidate.entry.scope || "default";
      const theta = thetaMap[scope] ?? thetaMap.default ?? this.defaultTheta;
      let activeWeight: number;
      try {
        activeWeight = await this.provider.getActiveWeight(topicId, scope);
      } catch {
        continue; // non-fatal: a broken provider must not break retrieval
      }
      if (typeof activeWeight !== "number" || !Number.isFinite(activeWeight)) continue;
      const boost = theta * activeWeight;
      candidate.score = (candidate.score || 0) + boost;
      candidate.scoreFinal = candidate.score;
      const sources = (candidate.sources || {}) as Record<string, unknown>;
      sources.clusterBoost = { score: boost, activeWeight, topicId, theta };
      candidate.sources = sources as typeof candidate.sources;
    }
    return candidates;
  }
}
