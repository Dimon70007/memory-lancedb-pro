import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient } = jiti("../src/llm-client.ts");
const { resolveOAuthCallbackListenHost } = jiti("../src/llm-oauth.ts");

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";
const originalFetch = globalThis.fetch;

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(payload) {
  return [
    encodeSegment({ alg: "none", typ: "JWT" }),
    encodeSegment(payload),
    "signature",
  ].join(".");
}

describe("LLM OAuth client", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "memory-llm-oauth-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the project OAuth file and sends a streaming Responses payload to the Codex backend", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_test_123",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    let requestUrl = "";
    let requestHeaders;
    let requestBody;

    globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(init?.body);
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text: "{\"memories\":[]}",
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        {
          status: 200,
        },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/gpt-5.4",
      oauthPath: authPath,
      timeoutMs: 5_000,
    });

    const result = await llm.completeJson("hello");
    assert.deepEqual(result, { memories: [] });
    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(requestHeaders.get("authorization"), `Bearer ${accessToken}`);
    assert.equal(requestHeaders.get("chatgpt-account-id"), "acct_test_123");
    assert.equal(requestHeaders.get("openai-beta"), "responses=experimental");
    assert.equal(requestBody.model, "gpt-5.4");
    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.input, [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "hello",
          },
        ],
      },
    ]);
    assert.equal(requestBody.store, false);
  });

  it("binds the OAuth callback server to the redirect host", () => {
    assert.equal(
      resolveOAuthCallbackListenHost("http://localhost:1455/auth/callback"),
      "localhost",
    );
    assert.equal(
      resolveOAuthCallbackListenHost("http://127.0.0.1:1455/auth/callback"),
      "127.0.0.1",
    );
    assert.equal(
      resolveOAuthCallbackListenHost("http://[::1]:1455/auth/callback"),
      "::1",
    );
  });

  it("recovers when the OAuth file appears after an initial missing-file failure", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_test_456",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    let requestCount = 0;

    globalThis.fetch = async () => {
      requestCount += 1;
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text: "{\"memories\":[]}",
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        {
          status: 200,
        },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/gpt-5.4",
      oauthPath: authPath,
      timeoutMs: 100,
    });

    assert.equal(await llm.completeJson("first"), null);

    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    assert.deepEqual(await llm.completeJson("second"), { memories: [] });
    assert.equal(requestCount, 1);
  });

  it("persists refreshed OAuth sessions before sending the backend request", async () => {
    const expiredAccessToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_old",
      },
    });
    const refreshedAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_new",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        access_token: expiredAccessToken,
        refresh_token: "refresh-old",
      }),
      "utf8",
    );

    let authorizationHeader = "";

    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: refreshedAccessToken,
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      authorizationHeader = new Headers(init?.headers).get("authorization") || "";
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text: "{\"memories\":[]}",
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        {
          status: 200,
        },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/gpt-5.4",
      oauthPath: authPath,
      timeoutMs: 100,
    });

    assert.deepEqual(await llm.completeJson("refresh me"), { memories: [] });
    assert.equal(authorizationHeader, `Bearer ${refreshedAccessToken}`);

    const persisted = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(persisted.provider, "openai-codex");
    assert.equal(persisted.access_token, refreshedAccessToken);
    assert.equal(persisted.refresh_token, "refresh-new");
    assert.equal(persisted.account_id, "acct_new");
    assert.ok(typeof persisted.updated_at === "string" && persisted.updated_at.length > 0);
  });

  it("falls back to the next OAuth model when the primary request fails", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_fallback",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    const modelsTried = [];
    const logs = [];

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init?.body);
      modelsTried.push(body.model);
      if (body.model === "gpt-primary-down") {
        return new Response("service unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text: "{\"ok\":true,\"via\":\"oauth-fallback\"}",
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        { status: 200 },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/gpt-primary-down",
      fallbacks: ["openai/gpt-fallback-up"],
      oauthPath: authPath,
      timeoutMs: 5_000,
      warnLog: (message) => logs.push(message),
    });

    const result = await llm.completeJson("hello", "oauth-fallback-probe");
    assert.deepEqual(result, { ok: true, via: "oauth-fallback" });
    assert.deepEqual(modelsTried, ["gpt-primary-down", "gpt-fallback-up"]);
    assert.equal(llm.getLastError(), null);
    assert.match(logs.join("\n"), /falling back to model openai\/gpt-fallback-up/i);
  });

  it("returns null when primary and all OAuth fallbacks fail", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_all_fail",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    const modelsTried = [];
    globalThis.fetch = async (_url, init) => {
      modelsTried.push(JSON.parse(init?.body).model);
      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/primary-down",
      fallbacks: ["openai/fallback-down"],
      oauthPath: authPath,
      timeoutMs: 5_000,
    });

    assert.equal(await llm.completeJson("hello", "oauth-all-fail"), null);
    assert.deepEqual(modelsTried, ["primary-down", "fallback-down"]);
    assert.match(String(llm.getLastError()), /fallback-down/);
  });

  it("falls back when primary OAuth response has empty content", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_empty",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    const modelsTried = [];
    globalThis.fetch = async (_url, init) => {
      const model = JSON.parse(init?.body).model;
      modelsTried.push(model);
      if (model === "primary-empty") {
        return new Response("event: response.completed\ndata: {}\n\n", { status: 200 });
      }
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text: "{\"empty\":false}",
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        { status: 200 },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/primary-empty",
      fallbacks: ["openai/fb"],
      oauthPath: authPath,
      timeoutMs: 5_000,
    });

    assert.deepEqual(await llm.completeJson("x", "oauth-empty"), { empty: false });
    assert.deepEqual(modelsTried, ["primary-empty", "fb"]);
  });

  it("falls back when primary OAuth response is non-JSON text", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_bad_json",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    const modelsTried = [];
    globalThis.fetch = async (_url, init) => {
      const model = JSON.parse(init?.body).model;
      modelsTried.push(model);
      const text = model === "primary" ? "not json" : "{\"ok\":1}";
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text,
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        { status: 200 },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/primary",
      fallbacks: ["openai/fb"],
      oauthPath: authPath,
      timeoutMs: 5_000,
    });

    assert.deepEqual(await llm.completeJson("x", "oauth-bad-json"), { ok: 1 });
    assert.deepEqual(modelsTried, ["primary", "fb"]);
  });

  it("dedupes OAuth openai/ aliases so the same backend model is not tried twice", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_alias",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    const modelsTried = [];
    globalThis.fetch = async (_url, init) => {
      modelsTried.push(JSON.parse(init?.body).model);
      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/gpt-alias",
      fallbacks: ["gpt-alias", "openai-codex/gpt-alias", "openai/other"],
      oauthPath: authPath,
      timeoutMs: 5_000,
    });

    assert.equal(await llm.completeJson("x", "oauth-alias-dedupe"), null);
    assert.deepEqual(modelsTried, ["gpt-alias", "other"]);
  });

  it("does not call a second OAuth model when primary succeeds", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_once",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    let hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      const eventPayload = JSON.stringify({
        type: "response.output_text.done",
        text: "{\"once\":true}",
      });
      return new Response(
        [
          "event: response.output_text.done",
          `data: ${eventPayload}`,
          "",
        ].join("\n"),
        { status: 200 },
      );
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/primary",
      fallbacks: ["openai/should-not-run"],
      oauthPath: authPath,
      timeoutMs: 5_000,
    });

    assert.deepEqual(await llm.completeJson("x", "oauth-no-need"), { once: true });
    assert.equal(hits, 1);
  });

  it("aborts stalled OAuth backend requests when timeoutMs elapses", async () => {
    const accessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      [ACCOUNT_ID_CLAIM]: {
        chatgpt_account_id: "acct_timeout",
      },
    });

    const authPath = path.join(tempDir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    let aborted = false;
    const logs = [];

    globalThis.fetch = async (_url, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    };

    const llm = createLlmClient({
      auth: "oauth",
      model: "openai/gpt-5.4",
      oauthPath: authPath,
      timeoutMs: 20,
      log: (message) => logs.push(message),
    });

    assert.equal(await llm.completeJson("timeout"), null);
    assert.equal(aborted, true);
    assert.ok(logs.some((message) => message.includes("OAuth request failed")));
  });
});
