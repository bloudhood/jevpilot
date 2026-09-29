import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  detect,
  detectorMarkerSelectors,
  orderFindings,
  type DetectorInput,
} from "../../src/detectors/detect.ts";
import { challengeSignatures, type ChallengeSignature } from "../../src/detectors/signatures.ts";
import type { ActionResult } from "../../src/executor/types.ts";
import type { Observation, Rect } from "../../src/observer/types.ts";

const rect: Rect = { x: 20, y: 20, width: 240, height: 80 };

function input(): DetectorInput {
  return {
    observation: {
      url: "http://127.0.0.1/",
      title: "Home",
      readyState: "complete",
      epoch: 1,
      viewport: { width: 1000, height: 800 },
      scroll: { x: 0, y: 0, maxY: 0 },
      elements: [],
      text: "",
      headings: [],
      forms: [],
      pageHash: "same",
      signals: {
        passwordFieldVisible: false,
        modalOverlay: false,
        dialogOpen: false,
        iframeOrigins: [],
        scriptOrigins: [],
        markers: { selectorMatches: [], iframes: [], scripts: [], scanMs: 0 },
      },
      timings: { snapshotMs: 0, totalMs: 0 },
    },
    navigation: { url: "http://127.0.0.1/", status: 200, headers: {} },
    recentActions: [],
    events: { popups: [], downloads: [] },
  };
}

function markers(state: DetectorInput): NonNullable<Observation["signals"]["markers"]> {
  const value = state.observation.signals.markers;
  assert.ok(value);
  return value;
}

function addVendorMarker(state: DetectorInput, signature: ChallengeSignature): void {
  const selector = signature.selectors?.find(
    (item) => item.source !== "heuristic" && (item.role === "widget" || item.role === "challenge"),
  );
  const iframe = signature.iframes?.find(
    (item) => item.source !== "heuristic" && (item.role === "widget" || item.role === "challenge"),
  );
  const script = signature.scripts?.find((item) => item.source !== "heuristic");
  if (selector)
    markers(state).selectorMatches.push({
      selector: selector.value,
      framePath: "",
      visible: true,
      rect,
    });
  else if (iframe)
    markers(state).iframes.push({
      url: iframe.hosts
        ? `https://${iframe.hosts[0]}/captcha${iframe.value}`
        : `https://${iframe.value}/widget`,
      framePath: "",
      visible: true,
      rect,
    });
  else if (script)
    markers(state).scripts.push({ url: `https://${script.value}/sdk.js`, framePath: "" });
}

function action(outcome: ActionResult["outcome"], pageHash = "same"): ActionResult {
  return {
    outcome,
    pageHash,
    url: "http://127.0.0.1/",
    changes: { url: false, pageHash: false, value: false, checked: false },
    timings: { precheckMs: 0, inputMs: 0, settleMs: 0, harnessMs: 0 },
  };
}

test("every signature has a fixture and every marker has provenance", async () => {
  const files = await readdir(new URL("../fixtures/detectors/", import.meta.url));
  for (const signature of challengeSignatures) {
    assert.ok(files.includes(`${signature.id}.html`), signature.id);
    for (const marker of [
      signature.headers,
      signature.urls,
      signature.iframes,
      signature.scripts,
      signature.selectors,
      signature.titles,
      signature.text,
    ].flat())
      if (marker) {
        assert.ok(["documented", "observed", "heuristic"].includes(marker.source));
        assert.ok(marker.note);
      }
  }
  assert.equal(
    new Set(challengeSignatures.map((signature) => signature.id)).size,
    challengeSignatures.length,
  );
  assert.ok(detectorMarkerSelectors().includes(".cf-turnstile"));
});

for (const signature of challengeSignatures)
  test(`${signature.id} signature requires blocking evidence`, () => {
    const state = input();
    const header = signature.headers?.find((item) => item.source === "documented");
    if (header && state.navigation) state.navigation.headers[header.name] = header.value;
    else if (signature.urls?.some((item) => item.role === "challenge") && state.navigation)
      state.navigation.url = `https://example.test${signature.urls.find((item) => item.role === "challenge")!.value}`;
    else if (signature.blockPage?.allOf && state.navigation) {
      state.navigation.status = signature.blockPage.statuses[0] ?? 403;
      state.observation.title = signature.blockPage.allOf.titles?.join(" ") ?? "";
      state.observation.text = [
        ...(signature.blockPage.allOf.text ?? []),
        ...(signature.blockPage.anyOf?.text?.slice(0, 1) ?? []),
      ].join(". ");
    } else {
      addVendorMarker(state, signature);
      if (
        !signature.selectors?.some(
          (item) => item.source !== "heuristic" && item.role !== "presence",
        ) &&
        !signature.iframes?.some(
          (item) => item.source !== "heuristic" && item.role !== "presence",
        ) &&
        state.navigation
      )
        state.navigation.status = signature.blockPage?.statuses[0] ?? 403;
    }
    assert.ok(
      detect(state).some(
        (finding) =>
          finding.kind === "challenge" &&
          finding.vendor === signature.vendor &&
          finding.level === "blocking",
      ),
      signature.id,
    );
  });

test("JD dedicated risk path blocks without other markers", () => {
  const state = input();
  state.observation.url = "https://cfe.m.jd.com/privatedomain/risk_handler/verify";
  if (state.navigation) state.navigation.url = state.observation.url;
  assert.ok(
    detect(state).some(
      (finding) =>
        finding.kind === "challenge" &&
        finding.level === "blocking" &&
        finding.vendor === "JD risk control",
    ),
  );
  state.observation.url = "https://cfe.m.jd.com/normal";
  if (state.navigation) state.navigation.url = state.observation.url;
  assert.ok(
    !detect(state).some((finding) => "vendor" in finding && finding.vendor === "JD risk control"),
  );
});

test("invisible reCAPTCHA badge, anchor, and g-recaptcha button stay advisory", () => {
  const state = input();
  markers(state).iframes.push({
    url: "https://www.google.com/recaptcha/api2/anchor?size=invisible",
    framePath: "",
    visible: true,
    rect: { x: 930, y: 700, width: 256, height: 60 },
  });
  markers(state).selectorMatches.push({
    selector: ".g-recaptcha",
    framePath: "",
    visible: true,
    rect,
  });
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "protection_present" && finding.vendor === "reCAPTCHA",
    ),
  );
  assert.equal(
    detect(state).some((finding) => finding.kind === "challenge"),
    false,
  );
});

test("visible bframe blocks for api2 and enterprise on both hosts", () => {
  for (const host of ["www.google.com", "www.recaptcha.net"])
    for (const family of ["api2", "enterprise"]) {
      const state = input();
      markers(state).iframes.push({
        url: `https://${host}/recaptcha/${family}/bframe`,
        framePath: "",
        visible: true,
        rect,
      });
      assert.ok(
        detect(state).some(
          (finding) => finding.kind === "challenge" && finding.vendor === "reCAPTCHA",
        ),
        `${host} ${family}`,
      );
    }
});

test("hidden reCAPTCHA challenge iframe stays advisory", () => {
  const state = input();
  markers(state).iframes.push({
    url: "https://www.google.com/recaptcha/api2/bframe",
    framePath: "",
    visible: false,
    rect,
  });
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "protection_present" && finding.vendor === "reCAPTCHA",
    ),
  );
  assert.equal(
    detect(state).some((finding) => finding.kind === "challenge"),
    false,
  );
});

test("hidden HUMAN challenge selector stays advisory", () => {
  const state = input();
  markers(state).selectorMatches.push({
    selector: "#px-captcha",
    framePath: "",
    visible: false,
    rect,
  });
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "protection_present" && finding.vendor === "HUMAN/PerimeterX",
    ),
  );
  assert.equal(
    detect(state).some((finding) => finding.kind === "challenge"),
    false,
  );
});

test("zero-width reCAPTCHA widget iframe stays advisory", () => {
  const state = input();
  markers(state).iframes.push({
    url: "https://www.google.com/recaptcha/api2/anchor?size=normal",
    framePath: "",
    visible: true,
    rect: { ...rect, width: 0 },
  });
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "protection_present" && finding.vendor === "reCAPTCHA",
    ),
  );
  assert.equal(
    detect(state).some((finding) => finding.kind === "challenge"),
    false,
  );
});

test("4x4 visible Turnstile iframe widget stays advisory", () => {
  const state = input();
  markers(state).iframes.push({
    url: "https://challenges.cloudflare.com/turnstile/v0/widget",
    framePath: "",
    visible: true,
    rect: { x: 20, y: 20, width: 4, height: 4 },
  });
  assert.ok(
    detect(state).some(
      (finding) =>
        finding.kind === "protection_present" && finding.vendor === "Cloudflare Turnstile",
    ),
  );
  assert.equal(
    detect(state).some((finding) => finding.kind === "challenge"),
    false,
  );
});

test("zero-height Turnstile widget selector stays advisory", () => {
  const state = input();
  markers(state).selectorMatches.push({
    selector: ".cf-turnstile",
    framePath: "",
    visible: true,
    rect: { ...rect, height: 0 },
  });
  assert.ok(
    detect(state).some(
      (finding) =>
        finding.kind === "protection_present" && finding.vendor === "Cloudflare Turnstile",
    ),
  );
  assert.equal(
    detect(state).some((finding) => finding.kind === "challenge"),
    false,
  );
});

test("hCaptcha checkbox and challenge frame roles block when visible", () => {
  for (const frame of ["checkbox", "challenge"]) {
    const state = input();
    markers(state).iframes.push({
      url: `https://hcaptcha.com/captcha#frame=${frame}`,
      framePath: "",
      visible: true,
      rect,
    });
    assert.ok(
      detect(state).some(
        (finding) => finding.kind === "challenge" && finding.vendor === "hCaptcha",
      ),
    );
  }
});

test("copy alone, status alone, and heuristic selector alone produce no advisory finding", () => {
  const state = input();
  state.observation.title = "Access Denied";
  state.observation.text = "Invoice Reference #123";
  assert.equal(
    detect(state).some((finding) => finding.kind === "protection_present"),
    false,
  );
  state.observation.title = "Home";
  state.observation.text = "";
  if (state.navigation) state.navigation.status = 403;
  markers(state).selectorMatches.push({
    selector: "#captcha_container",
    framePath: "",
    visible: true,
    rect,
  });
  assert.equal(
    detect(state).some(
      (finding) => finding.kind === "protection_present" || finding.kind === "challenge",
    ),
    false,
  );
});

test("Akamai 403 with Access Denied title alone has no vendor finding", () => {
  const state = input();
  assert.ok(state.navigation);
  state.navigation.status = 403;
  state.observation.title = "Access Denied";
  assert.equal(
    detect(state).some(
      (finding) =>
        (finding.kind === "challenge" || finding.kind === "protection_present") &&
        finding.vendor === "Akamai",
    ),
    false,
  );
});

test("Akamai 403 needs both block-page copy phrases", () => {
  for (const text of ["You don't have permission to access this page", "Reference #12345"]) {
    const state = input();
    assert.ok(state.navigation);
    state.navigation.status = 403;
    state.observation.title = "Access Denied";
    state.observation.text = text;
    assert.equal(
      detect(state).some(
        (finding) =>
          (finding.kind === "challenge" || finding.kind === "protection_present") &&
          finding.vendor === "Akamai",
      ),
      false,
      text,
    );
  }
});

test("Cloudflare JS Detections script is presence; documented headers block", () => {
  const state = input();
  markers(state).scripts.push({
    url: "https://example.com/cdn-cgi/challenge-platform/scripts/jsd/main.js",
    framePath: "",
  });
  assert.ok(
    detect(state).some(
      (finding) =>
        finding.kind === "protection_present" && finding.vendor === "Cloudflare challenge",
    ),
  );
  assert.equal(
    detect(state).some((finding) => finding.kind === "challenge"),
    false,
  );
  if (state.navigation) state.navigation.headers["cf-mitigated"] = "challenge";
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "challenge" && finding.vendor === "Cloudflare challenge",
    ),
  );
});

test("AWS documented header blocks independently of status", () => {
  const state = input();
  if (state.navigation) state.navigation.headers["x-amzn-waf-action"] = "captcha";
  assert.ok(
    detect(state).some((finding) => finding.kind === "challenge" && finding.vendor === "AWS WAF"),
  );
});

test("Imperva sensor alone is advisory; incident copy corroborates", () => {
  const state = input();
  markers(state).scripts.push({
    url: "https://example.com/_Incapsula_Resource?x=1",
    framePath: "",
  });
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "protection_present" && finding.vendor === "Imperva/Incapsula",
    ),
  );
  state.observation.text = "Request unsuccessful. Incapsula incident ID 42";
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "challenge" && finding.vendor === "Imperva/Incapsula",
    ),
  );
});

test("login URL ignores query and fragment, while modal or main-only signals block", () => {
  const state = input();
  state.observation.signals.passwordFieldVisible = true;
  if (state.navigation)
    state.navigation.url = "https://example.com/articles?redirect=/login#signin";
  assert.ok(detect(state).some((finding) => finding.kind === "login_form_present"));
  if (state.navigation) state.navigation.url = "https://example.com/login";
  assert.ok(detect(state).some((finding) => finding.kind === "login_wall"));
  if (state.navigation) state.navigation.url = state.observation.url;
  state.observation.signals.loginModalCoversViewport = true;
  assert.ok(detect(state).some((finding) => finding.kind === "login_wall"));
  state.observation.signals.loginModalCoversViewport = false;
  state.observation.signals.mainLoginFormOnly = true;
  assert.ok(detect(state).some((finding) => finding.kind === "login_wall"));
});

test("Xiaohongshu risk copy is a blocking challenge only with both markers", () => {
  const state = input();
  state.observation.text = "安全限制: IP存在风险";
  assert.ok(
    detect(state).some(
      (finding) =>
        finding.kind === "challenge" &&
        finding.level === "blocking" &&
        finding.vendor === "Xiaohongshu risk control",
    ),
  );
  state.observation.text = "安全限制 300012";
  assert.ok(
    detect(state).some(
      (finding) => finding.kind === "challenge" && finding.vendor === "Xiaohongshu risk control",
    ),
  );
  state.observation.text = "安全限制";
  assert.ok(
    !detect(state).some(
      (finding) => finding.kind === "challenge" && finding.vendor === "Xiaohongshu risk control",
    ),
  );
});

test("login text blocks only when observer reports modal structure", () => {
  const state = input();
  state.observation.signals.loginTextPanel = true;
  assert.ok(detect(state).some((finding) => finding.kind === "login_form_present"));
  state.observation.signals.loginTextModal = true;
  assert.ok(detect(state).some((finding) => finding.kind === "login_wall"));
});

test("required empty fields stay advisory", () => {
  const state = input();
  const element: Observation["elements"][number] = {
    ref: "e1",
    framePath: "",
    fingerprint: "x",
    role: "input",
    name: "姓名",
    tag: "input",
    inputType: "text",
    checked: false,
    selected: false,
    disabled: false,
    readonly: false,
    required: true,
    invalid: false,
    rect,
    inViewport: true,
    distanceBelowFold: 0,
  };
  state.observation.elements.push(element);
  state.observation.forms.push({
    id: "f",
    active: true,
    fields: [{ ref: "e1", required: true, empty: true }],
  });
  assert.deepEqual(
    detect(state).find((finding) => finding.kind === "required_empty"),
    {
      kind: "required_empty",
      level: "advisory",
      evidence: ["required empty e1"],
      fields: [{ ref: "e1", label: "姓名", type: "text", required: true }],
    },
  );
});

test("two unchanged actions need the same hash; two stale actions count", () => {
  const state = input();
  state.recentActions = [action("unchanged"), action("unchanged")];
  assert.ok(detect(state).some((finding) => finding.kind === "no_progress"));
  const first = state.recentActions[0];
  assert.ok(first);
  first.pageHash = "other";
  assert.equal(
    detect(state).some((finding) => finding.kind === "no_progress"),
    false,
  );
  state.recentActions = [action("stale"), action("stale")];
  assert.ok(detect(state).some((finding) => finding.kind === "no_progress"));
});

test("repeated covered fills on the same page count as no progress", () => {
  const state = input();
  state.recentActions = [action("covered"), action("covered")];
  assert.ok(detect(state).some((finding) => finding.kind === "no_progress"));
  state.recentActions[0]!.pageHash = "other";
  assert.ok(!detect(state).some((finding) => finding.kind === "no_progress"));
});

test("no progress ignores h1 then h2 when observation returns to h1", () => {
  const state = input();
  state.observation.pageHash = "h1";
  state.recentActions = [action("unchanged", "h1"), action("unchanged", "h2")];
  assert.equal(
    detect(state).some((finding) => finding.kind === "no_progress"),
    false,
  );
});

test("no progress requires previous and latest hashes to agree even when latest matches observation", () => {
  const state = input();
  state.observation.pageHash = "h2";
  state.recentActions = [action("unchanged", "h1"), action("unchanged", "h2")];
  assert.equal(
    detect(state).some((finding) => finding.kind === "no_progress"),
    false,
  );
});

test("Chinese gate checks each occurrence outside excluded spans", () => {
  const state = input();
  for (const name of [
    "立即支付",
    "去支付",
    "确认付款",
    "确认删除",
    "永久删除",
    "立即下单",
    "¥99 立即购买",
    "支付宝支付",
    "立即购买",
    "提交订单",
    "确认支付",
    "删除评论",
    "发布",
    "转账",
  ]) {
    state.candidateAction = { role: "button", name };
    assert.ok(
      detect(state).some((finding) => finding.kind === "irreversible" && finding.level === "gate"),
      name,
    );
  }
  for (const name of [
    "发送验证码",
    "获取验证码",
    "重新发送",
    "支付宝",
    "购物车",
    "加入购物车",
    "查看订单",
    "订单详情",
    "删除筛选",
    "清除筛选",
    "支付方式",
    "付款方式",
    "查看删除记录",
    "提交",
    "搜索",
  ]) {
    state.candidateAction = { role: "button", name };
    assert.equal(
      detect(state).some((finding) => finding.kind === "irreversible"),
      false,
      name,
    );
  }
});

test("English irreversible terms retain word boundaries and exclusions", () => {
  const state = input();
  for (const name of [
    "Buy",
    "Pay",
    "Checkout",
    "Place order",
    "Submit order",
    "Confirm payment",
    "Delete",
    "Remove account",
    "Remove item",
    "Post",
    "Publish",
    "Send",
    "Send message",
    "Transfer",
  ]) {
    state.candidateAction = { role: "button", name };
    assert.ok(
      detect(state).some((finding) => finding.kind === "irreversible"),
      name,
    );
  }
  for (const name of [
    "submit",
    "search",
    "research",
    "payment methods",
    "Remove filter",
    "Post settings",
    "Send code",
    "Send verification code",
  ]) {
    state.candidateAction = { role: "button", name };
    assert.equal(
      detect(state).some((finding) => finding.kind === "irreversible"),
      false,
      name,
    );
  }
});

test("irreversible scope ignores long headline links but gates short action links", () => {
  const state = input();
  state.candidateAction = {
    role: "link",
    name: "Open source project 发布 a detailed report about the community roadmap",
  };
  assert.equal(
    detect(state).some((finding) => finding.kind === "irreversible"),
    false,
  );
  state.candidateAction = { role: "link", name: "发布文章" };
  assert.equal(
    detect(state).some((finding) => finding.kind === "irreversible"),
    true,
  );
  state.candidateAction = { role: "button", name: "Delete" };
  assert.equal(
    detect(state).some((finding) => finding.kind === "irreversible"),
    true,
  );
});

test("blocking precedence preserves advisory, gate, and event findings", () => {
  const state = input();
  state.observation.signals.passwordFieldVisible = true;
  state.navigation = {
    url: "https://example.com/login",
    status: 500,
    headers: { "cf-mitigated": "challenge" },
  };
  state.pendingDialog = { kind: "confirm", message: "Continue?", defaultPrompt: "" };
  state.candidateAction = { role: "button", name: "Delete" };
  state.events.downloads.push({
    id: "d",
    url: "http://127.0.0.1/file",
    suggestedFilename: "file",
    state: "started",
  });
  assert.deepEqual(
    orderFindings(detect(state)).map((finding) => finding.kind),
    ["challenge", "error_page", "login_wall", "dialog", "download", "irreversible"],
  );
});

test("M6q: a visible Aliyun punishment frame over the page is a blocking challenge", () => {
  const punish =
    "https://search.damai.cn//searchajax.html/_____tmd_____/punish?x5secdata=x&x5step=2&action=captchacapslidev2";
  const shown = input();
  shown.observation.url = "https://search.damai.cn/search.html?keyword=q";
  markers(shown).iframes.push({
    url: punish,
    framePath: "",
    visible: true,
    rect: { x: 422, y: 246, width: 420, height: 320 },
  });
  const blocking = detect(shown).find((finding) => finding.kind === "challenge");
  assert.equal(blocking?.level, "blocking");
  assert.equal(blocking && "vendor" in blocking ? blocking.vendor : undefined, "Aliyun");

  const hidden = input();
  markers(hidden).iframes.push({
    url: punish,
    framePath: "",
    visible: false,
    rect: { x: 0, y: 0, width: 0, height: 0 },
  });
  const findings = detect(hidden);
  assert.equal(
    findings.some((finding) => finding.kind === "challenge"),
    false,
  );
  assert.equal(
    findings.some((finding) => finding.kind === "protection_present"),
    true,
  );
});
