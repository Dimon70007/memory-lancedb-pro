import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  createLlmClient,
  resolveLlmFallbacks,
  shouldDisableReasoningForJson,
  stripReasoningTrace,
} = jiti("../src/llm-client.ts");

describe("resolveLlmFallbacks", () => {
  it("prefers explicit plugin llm.fallbacks over agents.defaults.model.fallbacks", () => {
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "primary-model", fallbacks: ["plugin-fb-1", "primary-model", "  plugin-fb-2  "] },
        { agents: { defaults: { model: { fallbacks: ["global-fb"] } } } },
      ),
      ["plugin-fb-1", "plugin-fb-2"],
    );
  });

  it("inherits agents.defaults.model.fallbacks when plugin llm.fallbacks is omitted", () => {
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "openrouter/owl-alpha" },
        {
          agents: {
            defaults: {
              model: {
                primary: "openrouter/owl-alpha",
                fallbacks: ["openrouter/owl-alpha", "litellm/gemma4-26b-a4b", ""],
              },
            },
          },
        },
      ),
      ["litellm/gemma4-26b-a4b"],
    );
  });

  it("treats an explicit empty plugin fallbacks array as disable inheritance", () => {
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "primary-model", fallbacks: [] },
        { agents: { defaults: { model: { fallbacks: ["global-fb"] } } } },
      ),
      [],
    );
  });

  it("returns [] when openclaw config is missing or malformed", () => {
    assert.deepEqual(resolveLlmFallbacks({ model: "primary" }), []);
    assert.deepEqual(resolveLlmFallbacks({ model: "primary" }, null), []);
    assert.deepEqual(resolveLlmFallbacks({ model: "primary" }, "not-an-object"), []);
    assert.deepEqual(resolveLlmFallbacks({ model: "primary" }, { agents: null }), []);
    assert.deepEqual(resolveLlmFallbacks({ model: "primary" }, { agents: { defaults: {} } }), []);
    assert.deepEqual(
      resolveLlmFallbacks({ model: "primary" }, { agents: { defaults: { model: { fallbacks: null } } } }),
      [],
    );
  });

  it("ignores non-array agents.defaults.model.fallbacks shapes", () => {
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "primary" },
        { agents: { defaults: { model: { fallbacks: "litellm/one" } } } },
      ),
      [],
    );
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "primary" },
        { agents: { defaults: { model: { fallbacks: { model: "litellm/one" } } } } },
      ),
      [],
    );
  });

  it("dedupes inherited fallbacks and trims whitespace", () => {
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "  primary  " },
        {
          agents: {
            defaults: {
              model: {
                fallbacks: [
                  "  litellm/a  ",
                  "litellm/a",
                  "primary",
                  "   ",
                  "litellm/b",
                  "litellm/b",
                ],
              },
            },
          },
        },
      ),
      ["litellm/a", "litellm/b"],
    );
  });

  it("does not inherit from agents.list model.fallbacks (defaults only)", () => {
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "primary" },
        {
          agents: {
            list: [{ id: "main", model: { primary: "primary", fallbacks: ["agent-fb"] } }],
            defaults: { model: { primary: "primary" } },
          },
        },
      ),
      [],
    );
  });

  it("handles undefined plugin llm by reading global fallbacks", () => {
    assert.deepEqual(
      resolveLlmFallbacks(undefined, {
        agents: { defaults: { model: { fallbacks: ["global-only"] } } },
      }),
      ["global-only"],
    );
  });

  it("keeps case-sensitive distinction between primary and fallback ids", () => {
    assert.deepEqual(
      resolveLlmFallbacks(
        { model: "Primary" },
        { agents: { defaults: { model: { fallbacks: ["primary", "Primary"] } } } },
      ),
      ["primary"],
    );
  });
});

describe("LLM api-key client", () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  });

  it("uses chat.completions.create semantics with the provided api-key configuration", async () => {
    let requestHeaders;
    let requestBody;

    server = http.createServer(async (req, res) => {
      requestHeaders = req.headers;

      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"memories\":[]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "gpt-4o-mini",
      baseURL: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 4321,
    });

    const result = await llm.completeJson("hello", "api-key-probe");
    assert.deepEqual(result, { memories: [] });
    assert.equal(requestHeaders.authorization, "Bearer test-api-key");
    assert.equal(requestBody.model, "gpt-4o-mini");
    assert.deepEqual(requestBody.messages, [
      {
        role: "system",
        content: "You are a memory extraction assistant. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: "hello",
      },
    ]);
    assert.equal(requestBody.temperature, 0.1);
    assert.equal(requestBody.chat_template_kwargs, undefined);
  });

  it("disables thinking for reasoning models and strips reasoning traces before JSON parse", async () => {
    let requestBody;

    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requestBody = JSON.parse(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: "<think>plan first</think>{\"memories\":[{\"text\":\"clean json\"}]}",
            },
          },
        ],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "Qwen3.5-27B-FP8",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const result = await llm.completeJson("extract", "reasoning-probe");
    assert.deepEqual(result, { memories: [{ text: "clean json" }] });
    assert.deepEqual(requestBody.chat_template_kwargs, { enable_thinking: false });
  });

  it("detects known reasoning model names", () => {
    assert.equal(shouldDisableReasoningForJson("qwen3.5-27b-fp8"), true);
    assert.equal(shouldDisableReasoningForJson("DeepSeek-R1-Distill-Qwen-32B"), true);
    assert.equal(shouldDisableReasoningForJson("QwQ-32B"), true);
    assert.equal(shouldDisableReasoningForJson("gpt-4o-mini"), false);
    assert.equal(stripReasoningTrace("<think>{\"bad\":true}</think>{\"ok\":true}"), "{\"ok\":true}");
  });

  it("falls back to the next model when the primary request fails", async () => {
    const modelsTried = [];

    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      modelsTried.push(parsed.model);

      if (parsed.model === "primary-down") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "service unavailable" } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true,\"via\":\"fallback\"}" } }],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const logs = [];
    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "primary-down",
      fallbacks: ["fallback-up"],
      baseURL: `http://127.0.0.1:${port}/v1`,
      warnLog: (msg) => logs.push(msg),
    });

    const result = await llm.completeJson("hello", "fallback-probe");
    assert.deepEqual(result, { ok: true, via: "fallback" });
    assert.deepEqual(modelsTried, ["primary-down", "fallback-up"]);
    assert.equal(llm.getLastError(), null);
    assert.match(logs.join("\n"), /falling back to model fallback-up/i);
  });

  it("returns null when primary and all fallbacks fail", async () => {
    server = http.createServer(async (_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "test-api-key",
      model: "primary-down",
      fallbacks: ["fallback-down"],
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const result = await llm.completeJson("hello", "all-fail");
    assert.equal(result, null);
    assert.match(String(llm.getLastError()), /fallback-down/);
  });

  it("skips a failing first fallback and succeeds on the second", async () => {
    const modelsTried = [];
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      modelsTried.push(parsed.model);
      if (parsed.model === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{\"n\":2}" } }] }));
        return;
      }
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad gateway" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "k",
      model: "primary",
      fallbacks: ["fb1", "ok"],
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    const result = await llm.completeJson("x", "second-fb");
    assert.deepEqual(result, { n: 2 });
    assert.deepEqual(modelsTried, ["primary", "fb1", "ok"]);
  });

  it("falls back when primary returns empty content", async () => {
    const modelsTried = [];
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      modelsTried.push(parsed.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (parsed.model === "primary") {
        res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"recovered\":true}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "k",
      model: "primary",
      fallbacks: ["fb"],
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    assert.deepEqual(await llm.completeJson("x", "empty-primary"), { recovered: true });
    assert.deepEqual(modelsTried, ["primary", "fb"]);
  });

  it("falls back when primary returns non-JSON text", async () => {
    const modelsTried = [];
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      modelsTried.push(parsed.model);
      res.writeHead(200, { "Content-Type": "application/json" });
      const content = parsed.model === "primary" ? "not json at all" : "{\"ok\":1}";
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "k",
      model: "primary",
      fallbacks: ["fb"],
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    assert.deepEqual(await llm.completeJson("x", "bad-json"), { ok: 1 });
    assert.deepEqual(modelsTried, ["primary", "fb"]);
  });

  it("does not call a second model when primary succeeds", async () => {
    let hits = 0;
    server = http.createServer(async (_req, res) => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"once\":true}" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "k",
      model: "primary",
      fallbacks: ["should-not-run"],
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    assert.deepEqual(await llm.completeJson("x", "no-need"), { once: true });
    assert.equal(hits, 1);
  });

  it("dedupes duplicate fallback model ids before attempting requests", async () => {
    const modelsTried = [];
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      modelsTried.push(JSON.parse(body).model);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "down" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const llm = createLlmClient({
      auth: "api-key",
      apiKey: "k",
      model: "primary",
      fallbacks: ["fb", "fb", "primary", "  fb  "],
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    assert.equal(await llm.completeJson("x", "dedupe"), null);
    assert.deepEqual(modelsTried, ["primary", "fb"]);
  });
});
