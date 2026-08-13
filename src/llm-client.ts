/**
 * LLM Client for memory extraction and dedup decisions.
 * Uses OpenAI-compatible API (reuses the embedding provider config).
 */

import OpenAI from "openai";
import {
  buildOauthEndpoint,
  extractOutputTextFromSse,
  loadOAuthSession,
  needsRefresh,
  normalizeOauthModel,
  refreshOAuthSession,
  saveOAuthSession,
} from "./llm-oauth.js";

export interface LlmClientConfig {
  apiKey?: string;
  model: string;
  /** Ordered secondary models tried when the primary request fails. */
  fallbacks?: string[];
  baseURL?: string;
  auth?: "api-key" | "oauth";
  oauthPath?: string;
  oauthProvider?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Warn-level logger for user-visible failures (timeouts, retries, network errors). */
  warnLog?: (msg: string) => void;
}

export interface LlmClient {
  /** Send a prompt and parse the JSON response. Returns null on failure. */
  completeJson<T>(prompt: string, label?: string): Promise<T | null>;
  /** Best-effort diagnostics for the most recent failure, if any. */
  getLastError(): string | null;
}

/**
 * Extract JSON from an LLM response that may be wrapped in markdown fences
 * or contain surrounding text.
 */
function extractJsonFromResponse(text: string): string | null {
  text = stripReasoningTrace(text);

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) return null;
  return text.substring(firstBrace, lastBrace + 1);
}

function stripReasoningTrace(text: string): string {
  const closingThinkTag = text.toLowerCase().lastIndexOf("</think>");
  if (closingThinkTag === -1) return text;
  return text.slice(closingThinkTag + "</think>".length).trim();
}

function shouldDisableReasoningForJson(model: string): boolean {
  return /qwen3|deepseek.*r1|qwq/i.test(model);
}

function normalizeFallbackModels(primaryModel: string | undefined, raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const primary = typeof primaryModel === "string" ? primaryModel.trim() : "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed === primary || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Resolve secondary LLM models for smart-extraction.
 * Priority: explicit plugin `llm.fallbacks` (including []) > `agents.defaults.model.fallbacks`.
 */
export function resolveLlmFallbacks(
  pluginLlm: { model?: string; fallbacks?: unknown } | undefined,
  openclawConfig?: unknown,
): string[] {
  const primary = typeof pluginLlm?.model === "string" ? pluginLlm.model : undefined;
  const pluginFallbacks = normalizeFallbackModels(primary, pluginLlm?.fallbacks);
  if (pluginFallbacks) return pluginFallbacks;

  try {
    const root = openclawConfig as Record<string, unknown> | undefined;
    const agents = root?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const model = defaults?.model as Record<string, unknown> | undefined;
    return normalizeFallbackModels(primary, model?.fallbacks) ?? [];
  } catch {
    return [];
  }
}

function buildModelAttemptList(primary: string, fallbacks?: string[]): string[] {
  const list = [primary];
  const seen = new Set([primary.trim()]);
  for (const raw of fallbacks ?? []) {
    if (typeof raw !== "string") continue;
    const model = raw.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    list.push(model);
  }
  return list;
}

function previewText(value: string, maxLen = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function nextNonWhitespaceChar(text: string, start: number): string | undefined {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (!/\s/.test(ch)) return ch;
  }
  return undefined;
}

/**
 * Best-effort repair for common LLM JSON issues:
 * - unescaped quotes inside string values
 * - raw newlines / tabs inside strings
 * - trailing commas before } or ]
 */
function repairCommonJson(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        result += ch;
        escaped = true;
        continue;
      }

      if (ch === "\"") {
        const nextCh = nextNonWhitespaceChar(text, i + 1);
        if (
          nextCh === undefined ||
          nextCh === "," ||
          nextCh === "}" ||
          nextCh === "]" ||
          nextCh === ":"
        ) {
          result += ch;
          inString = false;
        } else {
          result += "\\\"";
        }
        continue;
      }

      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === "\"") {
      result += ch;
      inString = true;
      continue;
    }

    if (ch === ",") {
      const nextCh = nextNonWhitespaceChar(text, i + 1);
      if (nextCh === "}" || nextCh === "]") {
        continue;
      }
    }

    result += ch;
  }

  return result;
}

function looksLikeSseResponse(bodyText: string): boolean {
  const trimmed = bodyText.trimStart();
  return trimmed.startsWith("event:") || trimmed.startsWith("data:");
}

function createTimeoutSignal(timeoutMs?: number): { signal: AbortSignal; dispose: () => void } {
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

type CompleteJsonAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function createApiKeyClient(config: LlmClientConfig, log: (msg: string) => void, warnLog?: (msg: string) => void): LlmClient {
  if (!config.apiKey) {
    throw new Error("LLM api-key mode requires llm.apiKey or embedding.apiKey");
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs ?? 30000,
    // When plugin-level model fallbacks are configured, skip SDK retries so we
    // fail over to the next model instead of thrashing the same unavailable one.
    ...((config.fallbacks?.length ?? 0) > 0 ? { maxRetries: 0 } : {}),
  });
  let lastError: string | null = null;
  const models = buildModelAttemptList(config.model, config.fallbacks);

  async function completeJsonWithModel<T>(
    model: string,
    prompt: string,
    label: string,
  ): Promise<CompleteJsonAttempt<T>> {
    try {
      const request = {
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a memory extraction assistant. Always respond with valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        ...(shouldDisableReasoningForJson(model)
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {}),
      };

      const response = await client.chat.completions.create(request as any);

      const raw = response.choices?.[0]?.message?.content;
      if (!raw) {
        return {
          ok: false,
          error:
            `memory-lancedb-pro: llm-client [${label}] empty response content from model ${model}`,
        };
      }
      if (typeof raw !== "string") {
        return {
          ok: false,
          error:
            `memory-lancedb-pro: llm-client [${label}] non-string response content type=${Array.isArray(raw) ? "array" : typeof raw} from model ${model}`,
        };
      }

      const jsonStr = extractJsonFromResponse(raw);
      if (!jsonStr) {
        return {
          ok: false,
          error:
            `memory-lancedb-pro: llm-client [${label}] no JSON object found (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`,
        };
      }

      try {
        return { ok: true, value: JSON.parse(jsonStr) as T };
      } catch (err) {
        const repairedJsonStr = repairCommonJson(jsonStr);
        if (repairedJsonStr !== jsonStr) {
          try {
            const repaired = JSON.parse(repairedJsonStr) as T;
            log(
              `memory-lancedb-pro: llm-client [${label}] recovered malformed JSON via heuristic repair (jsonChars=${jsonStr.length})`,
            );
            return { ok: true, value: repaired };
          } catch (repairErr) {
            return {
              ok: false,
              error:
                `memory-lancedb-pro: llm-client [${label}] JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`,
            };
          }
        }
        return {
          ok: false,
          error:
            `memory-lancedb-pro: llm-client [${label}] JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        error:
          `memory-lancedb-pro: llm-client [${label}] request failed for model ${model}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      lastError = null;
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const result = await completeJsonWithModel<T>(model, prompt, label);
        if (result.ok === false) {
          lastError = result.error;
          const hasNext = i < models.length - 1;
          if (hasNext) {
            (warnLog ?? log)(
              `${result.error}; falling back to model ${models[i + 1]}`,
            );
            continue;
          }
          (warnLog ?? log)(result.error);
          return null;
        }
        lastError = null;
        return result.value;
      }
      return null;
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

function createOauthClient(config: LlmClientConfig, log: (msg: string) => void, warnLog?: (msg: string) => void): LlmClient {
  if (!config.oauthPath) {
    throw new Error("LLM oauth mode requires llm.oauthPath");
  }

  let cachedSessionPromise: Promise<Awaited<ReturnType<typeof loadOAuthSession>>> | null = null;
  let lastError: string | null = null;

  async function getSession() {
    if (!cachedSessionPromise) {
      cachedSessionPromise = loadOAuthSession(config.oauthPath!).catch((error) => {
        cachedSessionPromise = null;
        throw error;
      });
    }
    let session = await cachedSessionPromise;
    if (needsRefresh(session)) {
      session = await refreshOAuthSession(session, config.timeoutMs);
      await saveOAuthSession(config.oauthPath!, session);
      cachedSessionPromise = Promise.resolve(session);
    }
    return session;
  }

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      lastError = null;
      try {
        const session = await getSession();
        const { signal, dispose } = createTimeoutSignal(config.timeoutMs);
        const endpoint = buildOauthEndpoint(config.baseURL, config.oauthProvider);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.accessToken}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              "OpenAI-Beta": "responses=experimental",
              "chatgpt-account-id": session.accountId,
              originator: "codex_cli_rs",
            },
            signal,
            body: JSON.stringify({
              model: normalizeOauthModel(config.model),
              instructions:
                "You are a memory extraction assistant. Always respond with valid JSON only.",
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: prompt,
                    },
                  ],
                },
              ],
              store: false,
              stream: true,
              text: {
                format: { type: "text" },
              },
            }),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${detail.slice(0, 500)}`);
          }

          const bodyText = await response.text();
          const raw = (
            response.headers.get("content-type")?.includes("text/event-stream") ||
            looksLikeSseResponse(bodyText)
          )
            ? extractOutputTextFromSse(bodyText)
            : (() => {
                try {
                  const parsed = JSON.parse(bodyText) as Record<string, unknown>;
                  const output = Array.isArray(parsed.output) ? parsed.output : [];
                  const first = output.find(
                    (item) =>
                      item &&
                      typeof item === "object" &&
                      Array.isArray((item as Record<string, unknown>).content),
                  ) as Record<string, unknown> | undefined;
                  if (!first) return null;
                  const content = (first.content as Array<Record<string, unknown>>).find(
                    (part) => part?.type === "output_text" && typeof part.text === "string",
                  );
                  return typeof content?.text === "string" ? content.text : null;
                } catch {
                  return null;
                }
              })();

          if (!raw) {
            lastError =
              `memory-lancedb-pro: llm-client [${label}] empty OAuth response content from model ${config.model}`;
            log(lastError);
            return null;
          }

          const jsonStr = extractJsonFromResponse(raw);
          if (!jsonStr) {
            lastError =
              `memory-lancedb-pro: llm-client [${label}] no JSON object found in OAuth response (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
            log(lastError);
            return null;
          }

          try {
            return JSON.parse(jsonStr) as T;
          } catch (err) {
            const repairedJsonStr = repairCommonJson(jsonStr);
            if (repairedJsonStr !== jsonStr) {
              try {
                const repaired = JSON.parse(repairedJsonStr) as T;
                log(
                  `memory-lancedb-pro: llm-client [${label}] recovered malformed OAuth JSON via heuristic repair (jsonChars=${jsonStr.length})`,
                );
                return repaired;
              } catch (repairErr) {
                lastError =
                  `memory-lancedb-pro: llm-client [${label}] OAuth JSON.parse failed: ${err instanceof Error ? err.message : String(err)}; repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
                log(lastError);
                return null;
              }
            }
            lastError =
              `memory-lancedb-pro: llm-client [${label}] OAuth JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
            log(lastError);
            return null;
          }
        } finally {
          dispose();
        }
      } catch (err) {
        lastError =
          `memory-lancedb-pro: llm-client [${label}] OAuth request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        (warnLog ?? log)(lastError);
        return null;
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const log = config.log ?? (() => {});
  const warnLog = config.warnLog;
  if (config.auth === "oauth") {
    return createOauthClient(config, log, warnLog);
  }
  return createApiKeyClient(config, log, warnLog);
}

export { extractJsonFromResponse, repairCommonJson, shouldDisableReasoningForJson, stripReasoningTrace };
