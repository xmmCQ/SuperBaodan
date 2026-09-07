import test from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_SECRET,
  VALID_THINKING_LEVELS,
  mergeSecretPlaceholders,
  parseJsonc,
  piPackageRoot,
  redactSecrets,
  validateAndNormalizeModelsConfig,
} from "../lib/pi-admin.mjs";

test("piPackageRoot honors explicit Windows Pi package", () => {
  assert.equal(piPackageRoot({ SUPER_BAODAN_PI_PACKAGE: "C:\\Pi" }), "C:\\Pi");
});

test("Pi thinking preferences accept xhigh and reject unknown levels", () => {
  assert.equal(VALID_THINKING_LEVELS.has("xhigh"), true);
  assert.equal(VALID_THINKING_LEVELS.has("ultra"), false);
});

test("parseJsonc accepts comments and trailing commas without corrupting URLs", () => {
  const value = parseJsonc(`{
    // provider config
    "providers": {
      "demo": {
        "baseUrl": "https://example.com/v1", /* keep URL */
        "models": [{ "id": "gpt-demo", }],
      },
    },
  }`);
  assert.equal(value.providers.demo.baseUrl, "https://example.com/v1");
  assert.equal(value.providers.demo.models[0].id, "gpt-demo");
  assert.equal(parseJsonc('{"text":"comma, } stays",}').text, "comma, } stays");
});

test("redactSecrets masks keys and sensitive headers and merge restores them", () => {
  const original = {
    providers: {
      demo: {
        apiKey: "secret-key",
        headers: { Authorization: "Bearer secret", "X-Trace": "safe" },
        models: [{ id: "one" }],
      },
    },
  };
  const redacted = redactSecrets(original);
  assert.equal(redacted.providers.demo.apiKey, KEEP_SECRET);
  assert.equal(redacted.providers.demo.headers.Authorization, KEEP_SECRET);
  assert.equal(redacted.providers.demo.headers["X-Trace"], "safe");
  assert.deepEqual(mergeSecretPlaceholders(redacted, original), original);
});

test("validateAndNormalizeModelsConfig preserves unknown fields and completes cost", () => {
  const value = validateAndNormalizeModelsConfig({ providers: { demo: { baseUrl: "https://example.com", api: "openai-completions", extra: { future: true }, models: [{ id: "m1", unknown: 7, cost: { input: 1 } }] } } });
  assert.equal(value.providers.demo.extra.future, true);
  assert.equal(value.providers.demo.models[0].unknown, 7);
  assert.deepEqual(value.providers.demo.models[0].cost, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("validateAndNormalizeModelsConfig rejects invalid and duplicate models", () => {
  assert.throws(() => validateAndNormalizeModelsConfig({ providers: { demo: { models: [{ id: "x" }, { id: "x" }] } } }), /重复模型ID/);
  assert.throws(() => validateAndNormalizeModelsConfig({ providers: { demo: { baseUrl: "not a url", models: [] } } }), /Base URL无效/);
  assert.throws(() => validateAndNormalizeModelsConfig({ providers: { demo: { models: [{ id: "x", maxTokens: -1 }] } } }), /maxTokens无效/);
});
