import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findChrome } from "../../../src/browser/launcher.ts";
import {
  MIN_VISIBLE_CHALLENGE_SIZE,
  detect,
  detectorMarkerSelectors,
  type DetectorInput,
} from "../../../src/detectors/detect.ts";
import { challengeSignatures } from "../../../src/detectors/signatures.ts";
import { createCdpDriver } from "../../../src/engine/cdp/driver.ts";
import type { BrowserHandle, NavigationResult, PageHandle } from "../../../src/engine/types.ts";
import { observe } from "../../../src/observer/observe.ts";
import { testProfile } from "../../support/browser-profile.ts";

const executable = await findChrome();
const skipped =
  process.env.JEVPILOT_SKIP_BROWSER === "1"
    ? "JEVPILOT_SKIP_BROWSER=1"
    : !executable
      ? "Chrome executable not found"
      : undefined;
const fixtureRoot = new URL("../../fixtures/detectors/", import.meta.url);
const longFixture = new URL("../../fixtures/pages/long.html", import.meta.url);

describe("real Chrome deterministic detectors", { skip: skipped }, () => {
  let server: Server;
  let browser: BrowserHandle;
  let directory: string;
  let baseUrl: string;

  before(async () => {
    const pages = new Map<string, string>();
    const vendorHosts = new Set<string>(["unreachable.jevpilot.invalid"]);
    for (const name of await readdir(fixtureRoot)) {
      if (!name.endsWith(".html")) continue;
      const html = await readFile(new URL(name, fixtureRoot), "utf8");
      pages.set(`/${name.slice(0, -5)}`, html);
      for (const match of html.matchAll(/src="(https?:\/\/[^" ]+)"/gu))
        vendorHosts.add(new URL((match[1] ?? "").replaceAll("&amp;", "&")).hostname);
    }
    pages.set("/long", await readFile(longFixture, "utf8"));
    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (path === "/jd_risk_control") {
        response.statusCode = 302;
        response.setHeader("location", "/privatedomain/risk_handler/jd_risk_control");
        response.end();
        return;
      }
      if (path === "/cloudflare") response.setHeader("cf-mitigated", "challenge");
      if (path === "/akamai") response.statusCode = 403;
      if (path === "/aws_waf") {
        response.statusCode = 405;
        response.setHeader("x-amzn-waf-action", "captcha");
      }
      if (path === "/404") response.statusCode = 404;
      if (path === "/500") response.statusCode = 500;
      response.end(
        pages.get(path) ??
          (path === "/privatedomain/risk_handler/jd_risk_control"
            ? pages.get("/jd_risk_control")
            : undefined) ??
          pages.get("/error") ??
          "",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("local fixture server has no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    directory = await mkdtemp(join(tmpdir(), "jevpilot-detectors-"));
    browser = await createCdpDriver().launch(
      {
        ...testProfile(directory),
        executable,
        extraArgs: [
          ...(testProfile(directory).extraArgs ?? []),
          "--no-proxy-server",
          `--host-resolver-rules=${[...vendorHosts].map((host) => `MAP ${host} 127.0.0.1:9`).join(",")}`,
        ],
      },
      { timeoutMs: 15000 },
    );
  });

  after(async () => {
    await browser?.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function inspect(
    path: string,
  ): Promise<{ input: DetectorInput; navigation: NavigationResult }> {
    const page = await browser.newPage();
    try {
      const navigation = await page.navigate(`${baseUrl}${path}`);
      const observation = await observe(page, { markerSelectors: detectorMarkerSelectors() });
      return {
        navigation,
        input: {
          observation,
          navigation,
          recentActions: [],
          events: { popups: [], downloads: [] },
        },
      };
    } finally {
      await page.close();
    }
  }

  for (const signature of challengeSignatures) {
    test(`blocks ${signature.id} fixture without vendor network`, async () => {
      const { input } = await inspect(`/${signature.id}`);
      assert.ok(
        detect(input).some(
          (finding) =>
            finding.kind === "challenge" &&
            finding.vendor === signature.vendor &&
            finding.level === "blocking",
        ),
        signature.id,
      );
    });
  }

  test("detects Cloudflare response header and Just a moment title", async () => {
    const { input, navigation } = await inspect("/cloudflare");
    assert.equal(navigation.headers["cf-mitigated"], "challenge");
    assert.ok(
      detect(input).some(
        (finding) =>
          finding.kind === "challenge" &&
          finding.vendor === "Cloudflare challenge" &&
          finding.level === "blocking",
      ),
    );
  });
  test("login URL plus visible password is a login wall", async () => {
    const { input } = await inspect("/login");
    assert.equal(input.observation.signals.passwordFieldVisible, true);
    assert.ok(detect(input).some((finding) => finding.kind === "login_wall"));
  });
  test("Xiaohongshu risk copy blocks as a challenge", async () => {
    const { input } = await inspect("/xiaohongshu-risk-control");
    assert.ok(
      detect(input).some(
        (finding) =>
          finding.kind === "challenge" &&
          finding.vendor === "Xiaohongshu risk control" &&
          finding.level === "blocking",
      ),
    );
  });
  test("QR login modal blocks without a password field", async () => {
    const { input } = await inspect("/login_qr_modal");
    assert.equal(input.observation.signals.passwordFieldVisible, false);
    assert.ok(detect(input).some((finding) => finding.kind === "login_wall"));
  });
  test("SMS login modal blocks without a password field", async () => {
    const { input } = await inspect("/login_sms_modal");
    assert.equal(input.observation.signals.passwordFieldVisible, false);
    assert.ok(detect(input).some((finding) => finding.kind === "login_wall"));
  });
  test("inline login panel stays advisory", async () => {
    const { input } = await inspect("/login_inline_panel");
    assert.ok(detect(input).some((finding) => finding.kind === "login_form_present"));
    assert.ok(!detect(input).some((finding) => finding.kind === "login_wall"));
  });
  test("blocks a main-content login wall", async () => {
    const { input } = await inspect("/gate_form");
    assert.equal(input.observation.signals.mainLoginFormOnly, true);
    assert.ok(
      detect(input).some(
        (finding) => finding.kind === "login_wall" && finding.level === "blocking",
      ),
    );
  });
  test("reports required empty form fields as advisory", async () => {
    const { input } = await inspect("/required");
    const finding = detect(input).find((item) => item.kind === "required_empty");
    assert.equal(finding?.fields[0]?.label, "Name");
    assert.equal(finding?.level, "advisory");
  });
  test("invisible reCAPTCHA v3 on login form is advisory", async () => {
    const { input } = await inspect("/recaptcha_v3_form");
    assert.ok(
      input.observation.signals.markers?.iframes.some(
        (frame) => frame.url.includes("size=invisible") && frame.visible,
      ),
    );
    assert.ok(
      detect(input).some(
        (finding) => finding.kind === "protection_present" && finding.vendor === "reCAPTCHA",
      ),
    );
    assert.equal(
      detect(input).some((finding) => finding.kind === "challenge"),
      false,
    );
  });
  test("invisible v2 submit button is advisory", async () => {
    const { input } = await inspect("/recaptcha_invisible_v2");
    assert.ok(
      detect(input).some(
        (finding) => finding.kind === "protection_present" && finding.vendor === "reCAPTCHA",
      ),
    );
    assert.equal(
      detect(input).some((finding) => finding.kind === "challenge"),
      false,
    );
  });
  test("visible reCAPTCHA bframe blocks", async () => {
    const { input } = await inspect("/recaptcha_bframe");
    assert.ok(
      detect(input).some(
        (finding) => finding.kind === "challenge" && finding.vendor === "reCAPTCHA",
      ),
    );
  });
  test("recaptcha_bframe_hidden stays advisory", async () => {
    const { input } = await inspect("/recaptcha_bframe_hidden");
    const bframe = input.observation.signals.markers?.iframes.find((frame) =>
      frame.url.includes("/recaptcha/api2/bframe"),
    );
    assert.equal(bframe?.visible, false);
    assert.ok(
      detect(input).some(
        (finding) => finding.kind === "protection_present" && finding.vendor === "reCAPTCHA",
      ),
    );
    assert.equal(
      detect(input).some((finding) => finding.kind === "challenge"),
      false,
    );
  });
  test("hcaptcha_challenge_hidden stays advisory", async () => {
    const { input } = await inspect("/hcaptcha_challenge_hidden");
    const challengeFrame = input.observation.signals.markers?.iframes.find((frame) =>
      frame.url.includes("#frame=challenge"),
    );
    assert.equal(challengeFrame?.visible, false);
    assert.ok(
      detect(input).some(
        (finding) => finding.kind === "protection_present" && finding.vendor === "hCaptcha",
      ),
    );
    assert.equal(
      detect(input).some((finding) => finding.kind === "challenge"),
      false,
    );
  });
  test("turnstile_zero_size stays advisory", async () => {
    const { input } = await inspect("/turnstile_zero_size");
    const iframe = input.observation.signals.markers?.iframes.find((frame) =>
      frame.url.includes("challenges.cloudflare.com"),
    );
    assert.ok(iframe);
    assert.ok(iframe.rect.width < MIN_VISIBLE_CHALLENGE_SIZE);
    assert.ok(iframe.rect.height < MIN_VISIBLE_CHALLENGE_SIZE);
    assert.ok(
      detect(input).some(
        (finding) =>
          finding.kind === "protection_present" && finding.vendor === "Cloudflare Turnstile",
      ),
    );
    assert.equal(
      detect(input).some((finding) => finding.kind === "challenge"),
      false,
    );
  });
  test("Imperva resource script alone is advisory", async () => {
    const { input } = await inspect("/imperva_script_only");
    assert.ok(
      detect(input).some(
        (finding) =>
          finding.kind === "protection_present" && finding.vendor === "Imperva/Incapsula",
      ),
    );
    assert.equal(
      detect(input).some((finding) => finding.kind === "challenge"),
      false,
    );
  });
  test("Akamai CDN asset does not indicate a challenge", async () => {
    const { input } = await inspect("/akamai_cdn");
    assert.equal(
      detect(input).some(
        (finding) =>
          finding.kind === "challenge" ||
          (finding.kind === "protection_present" && finding.vendor === "Akamai"),
      ),
      false,
    );
  });
  test("header login box on content page is advisory", async () => {
    const { input } = await inspect("/header_account_box");
    assert.ok(detect(input).some((finding) => finding.kind === "login_form_present"));
    assert.equal(
      detect(input).some((finding) => finding.kind === "login_wall"),
      false,
    );
  });
  for (const name of ["modal_native", "modal_aria", "modal_custom"])
    test(`${name} blocks as login wall`, async () => {
      const { input } = await inspect(`/${name}`);
      assert.equal(input.observation.signals.loginModalCoversViewport, true, name);
      assert.ok(
        detect(input).some((finding) => finding.kind === "login_wall"),
        name,
      );
    });
  test("inline login panel stays advisory", async () => {
    const { input } = await inspect("/aside_password_panel");
    assert.ok(detect(input).some((finding) => finding.kind === "login_form_present"));
    assert.equal(
      detect(input).some((finding) => finding.kind === "login_wall"),
      false,
    );
  });
  test("query redirect to login does not make header form a wall", async () => {
    const { input } = await inspect("/header_account_box?redirect=/login#signin");
    assert.ok(detect(input).some((finding) => finding.kind === "login_form_present"));
    assert.equal(
      detect(input).some((finding) => finding.kind === "login_wall"),
      false,
    );
  });
  for (const status of [404, 500])
    test(`detects ${status} main-document response`, async () => {
      const { input } = await inspect(`/${status}`);
      assert.ok(
        detect(input).some((finding) => finding.kind === "error_page" && finding.status === status),
      );
    });
  test("detects unreachable navigation as error page", async () => {
    const page: PageHandle = await browser.newPage();
    try {
      let failure: string | undefined;
      try {
        await page.navigate("http://unreachable.jevpilot.invalid/");
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause);
      }
      const observation = await observe(page, { markerSelectors: detectorMarkerSelectors() });
      const input: DetectorInput = {
        observation,
        navigation: {
          url: observation.url,
          status: 0,
          headers: {},
          ...(failure ? { failure } : {}),
        },
        recentActions: [],
        events: { popups: [], downloads: [] },
      };
      assert.ok(detect(input).some((finding) => finding.kind === "error_page"));
    } finally {
      await page.close();
    }
  });
  test("marker scan stays within 10 ms on long fixture", async () => {
    const { input } = await inspect("/long");
    assert.ok(
      (input.observation.signals.markers?.scanMs ?? Infinity) <= 10,
      `marker scan ${input.observation.signals.markers?.scanMs} ms`,
    );
  });
});
