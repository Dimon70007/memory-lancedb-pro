import { parseSmartMetadata } from "./smart-metadata.js";
/**
 * Default cluster_boost strategy. Reads each candidate's `parent_topic_id`
 * (from smart metadata), looks up the topic's utility-based active_weight via
 * the injected `TopicClusterProvider`, and adds `theta * active_weight`.
 */
export class ClusterBoostStrategy {
    provider;
    defaultTheta;
    constructor(provider, defaultTheta = 0.08) {
        this.provider = provider;
        this.defaultTheta = defaultTheta;
    }
    async boost(candidates, ctx) {
        // Snapshot pre/post scores for recall_log (§4: score_raw vs score_final).
        for (const candidate of candidates) {
            candidate.scoreRaw = candidate.score;
            candidate.scoreFinal = candidate.score;
        }
        if (!ctx.clusterBoostEnabled)
            return candidates;
        const thetaMap = ctx.clusterBoostTheta && Object.keys(ctx.clusterBoostTheta).length > 0
            ? ctx.clusterBoostTheta
            : { default: this.defaultTheta };
        for (const candidate of candidates) {
            const metadata = parseSmartMetadata(candidate.entry.metadata, candidate.entry);
            const topicId = metadata?.parent_topic_id;
            if (typeof topicId !== "string" || !topicId)
                continue;
            const scope = candidate.entry.scope || "default";
            const theta = thetaMap[scope] ?? thetaMap.default ?? this.defaultTheta;
            let activeWeight;
            try {
                activeWeight = await this.provider.getActiveWeight(topicId, scope);
            }
            catch {
                continue; // non-fatal: a broken provider must not break retrieval
            }
            if (typeof activeWeight !== "number" || !Number.isFinite(activeWeight))
                continue;
            const boost = theta * activeWeight;
            candidate.score = (candidate.score || 0) + boost;
            candidate.scoreFinal = candidate.score;
            const sources = (candidate.sources || {});
            sources.clusterBoost = { score: boost, activeWeight, topicId, theta };
            candidate.sources = sources;
        }
        return candidates;
    }
}
