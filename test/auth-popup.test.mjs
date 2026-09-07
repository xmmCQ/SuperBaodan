import test from "node:test";
import assert from "node:assert/strict";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; this.textContent = ""; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  trigger(type) { return this.listeners.get(type)?.(); }
}

function createController(createAuthController, api, loginProgress) {
  return createAuthController({
    state: { activeLoginSource: null },
    elements: { loginProgress },
    api,
    uiDialogs: {},
    showNotice() {},
    showError() {},
    showSettingsToast() {},
    loadBootstrap() {},
    loadModelCatalog() {},
  });
}

test("ChatGPT浏览器登录预先打开窗口并在收到授权地址后跳转", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const calls = [];
  const popup = {
    closed: false,
    opener: {},
    location: { href: "about:blank" },
    document: { title: "", body: { textContent: "" } },
    close() { this.closed = true; },
  };
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.window = { open() { calls.push("open"); return popup; } };
  try {
    const { createAuthController } = await import(`../public/assistant/auth-controller.js?test=${Date.now()}`);
    const loginProgress = new FakeElement();
    const controller = createController(createAuthController, async () => { calls.push("api"); return {}; }, loginProgress);

    controller.renderLoginInputControls("openai-codex", "token", "", [{ id: "browser", label: "Browser login (default)" }]);
    const browserButton = loginProgress.children[0].children[0];
    await browserButton.trigger("click");
    assert.deepEqual(calls, ["open", "api"]);
    assert.equal(popup.opener, null);
    assert.match(popup.document.body.textContent, /正在获取 ChatGPT 登录地址/);

    controller.renderOAuthAction({ id: "openai-codex", name: "ChatGPT Plus\/Pro" }, {
      url: "https://auth.openai.com/oauth/authorize?test=1",
      instructions: "A browser window should open. Complete login to finish.",
    });
    assert.equal(popup.location.href, "https://auth.openai.com/oauth/authorize?test=1");
    assert.match(loginProgress.children[0].textContent, /已打开浏览器窗口/);
    assert.equal(loginProgress.children[1].textContent, "重新打开授权页面");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test("Anthropic等直接登录供应商自动打开对应网页", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalEventSource = globalThis.EventSource;
  const popups = [];
  const sources = [];
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.window = { open() {
    const popup = { closed: false, opener: {}, location: { href: "about:blank" }, document: { title: "", body: { textContent: "" } }, close() { this.closed = true; } };
    popups.push(popup); return popup;
  } };
  globalThis.EventSource = class {
    constructor(url) { this.url = url; sources.push(this); }
    close() {}
  };
  try {
    const { createAuthController } = await import(`../public/assistant/auth-controller.js?providers=${Date.now()}`);
    const loginProgress = new FakeElement();
    const controller = createController(createAuthController, async () => ({}), loginProgress);
    const flows = [
      ["anthropic", "auth", "https://console.anthropic.com/oauth/authorize"],
      ["openrouter", "auth", "https://openrouter.ai/auth"],
      ["kimi-coding", "device_code", "https://kimi.com/device"],
      ["xai", "device_code", "https://x.ai/device"],
    ];
    for (const [id, type, url] of flows) {
      controller.startOAuthLogin({ id, name: id });
      const source = sources.at(-1);
      source.onmessage({ data: JSON.stringify(type === "auth"
        ? { type, url }
        : { type, verificationUri: url, userCode: "ABCD" }) });
      assert.equal(popups.at(-1).location.href, url, id);
    }
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.EventSource = originalEventSource;
  }
});

test("GitHub和Radius在用户完成前置选择后打开验证页面", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const popups = [];
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.window = { open() {
    const popup = { closed: false, opener: {}, location: { href: "about:blank" }, document: { title: "", body: { textContent: "" } }, close() { this.closed = true; } };
    popups.push(popup); return popup;
  } };
  try {
    const { createAuthController } = await import(`../public/assistant/auth-controller.js?prompts=${Date.now()}`);
    const loginProgress = new FakeElement();
    const controller = createController(createAuthController, async () => ({}), loginProgress);

    controller.renderLoginInputControls("github-copilot", "github-token", "企业地址", null);
    await loginProgress.children[1].trigger("click");
    controller.renderDeviceCode({ id: "github-copilot", name: "GitHub Copilot" }, { verificationUri: "https://github.com/login/device", userCode: "CODE" });
    assert.equal(popups.at(-1).location.href, "https://github.com/login/device");

    controller.renderLoginInputControls("radius", "radius-token", "", [{ id: "device-code", label: "Device code" }]);
    await loginProgress.children.at(-1).children[0].trigger("click");
    controller.renderDeviceCode({ id: "radius", name: "Radius" }, { verificationUri: "https://radius.example/device", userCode: "CODE" });
    assert.equal(popups.at(-1).location.href, "https://radius.example/device");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test("浏览器拦截自动窗口时保留手动授权链接", async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.window = { open: () => null };
  try {
    const { createAuthController } = await import(`../public/assistant/auth-controller.js?blocked=${Date.now()}`);
    const loginProgress = new FakeElement();
    const controller = createController(createAuthController, async () => ({}), loginProgress);

    controller.renderLoginInputControls("openai-codex", "token", "", [{ id: "browser", label: "Browser login (default)" }]);
    await loginProgress.children[0].children[0].trigger("click");
    controller.renderOAuthAction({ id: "openai-codex", name: "ChatGPT Plus\/Pro" }, {
      url: "https://auth.openai.com/oauth/authorize?test=2",
    });
    assert.match(loginProgress.children[0].textContent, /浏览器未能自动打开/);
    assert.equal(loginProgress.children[1].textContent, "打开授权页面");
    assert.equal(loginProgress.children[1].href, "https://auth.openai.com/oauth/authorize?test=2");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});
