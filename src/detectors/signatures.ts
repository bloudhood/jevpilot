export type Provenance = "documented" | "observed" | "heuristic";
export type SignatureMarker = {
  value: string;
  source: Provenance;
  note: string;
  role?: "presence" | "widget" | "challenge";
  unless?: string;
  hosts?: string[];
};
export type ChallengeSignature = {
  id: string;
  vendor: string;
  autoPassPlausible: boolean;
  headers?: (SignatureMarker & { name: string })[];
  statuses?: number[];
  urls?: SignatureMarker[];
  iframes?: SignatureMarker[];
  scripts?: SignatureMarker[];
  selectors?: SignatureMarker[];
  titles?: SignatureMarker[];
  text?: SignatureMarker[];
  blockPage?: {
    statuses: number[];
    anyVendorMarker?: boolean;
    copyOnly?: boolean;
    allOf?: { titles?: string[]; text?: string[] };
    anyOf?: { text?: string[] };
  };
};

export const challengeSignatures: readonly ChallengeSignature[] = [
  {
    id: "xiaohongshu-risk-control",
    vendor: "Xiaohongshu risk control",
    autoPassPlausible: false,
    text: [
      { value: "安全限制", source: "observed", note: "risk restriction heading" },
      { value: "IP存在风险", source: "observed", note: "IP risk explanation" },
      { value: "300012", source: "observed", note: "risk restriction error code" },
    ],
    blockPage: {
      statuses: [],
      copyOnly: true,
      allOf: { text: ["安全限制"] },
      anyOf: { text: ["IP存在风险", "300012"] },
    },
  },
  {
    id: "jd_risk_control",
    vendor: "JD risk control",
    autoPassPlausible: false,
    urls: [
      {
        value: "/privatedomain/risk_handler/",
        source: "observed",
        note: "JD risk-control redirect path",
        role: "challenge",
      },
    ],
  },
  {
    id: "cloudflare",
    vendor: "Cloudflare challenge",
    autoPassPlausible: true,
    headers: [
      {
        name: "cf-mitigated",
        value: "challenge",
        source: "documented",
        note: "Cloudflare Detect a Challenge Page response",
      },
    ],
    scripts: [
      {
        value: "/cdn-cgi/challenge-platform/",
        source: "observed",
        note: "Cloudflare JS Detections script; presence only",
        role: "presence",
      },
      {
        value: "challenges.cloudflare.com/turnstile/",
        source: "documented",
        note: "Cloudflare Turnstile client-side rendering; only corroborates an interstitial",
        role: "presence",
      },
    ],
    selectors: [
      {
        value: "#challenge-form",
        source: "observed",
        note: "Cloudflare interstitial form",
        role: "challenge",
      },
    ],
    titles: [{ value: "Just a moment", source: "observed", note: "Cloudflare interstitial title" }],
    text: [
      { value: "Checking your browser", source: "observed", note: "Cloudflare interstitial copy" },
      {
        value: "请完成安全验证",
        source: "heuristic",
        note: "generic Chinese security verification copy",
      },
    ],
  },
  {
    id: "turnstile",
    vendor: "Cloudflare Turnstile",
    autoPassPlausible: true,
    iframes: [
      {
        value: "challenges.cloudflare.com",
        source: "documented",
        note: "Cloudflare Turnstile widget components",
        role: "widget",
      },
    ],
    scripts: [
      {
        value: "challenges.cloudflare.com/turnstile/",
        source: "documented",
        note: "Cloudflare client-side rendering",
        role: "presence",
      },
    ],
    selectors: [
      {
        value: ".cf-turnstile",
        source: "documented",
        note: "Cloudflare widget configurations",
        role: "widget",
      },
    ],
  },
  {
    id: "recaptcha",
    vendor: "reCAPTCHA",
    autoPassPlausible: false,
    iframes: [
      {
        value: "/recaptcha/api2/anchor",
        source: "observed",
        note: "reCAPTCHA widget iframe",
        role: "widget",
        unless: "size=invisible",
        hosts: ["google.com", "recaptcha.net"],
      },
      {
        value: "/recaptcha/enterprise/anchor",
        source: "observed",
        note: "reCAPTCHA enterprise widget iframe",
        role: "widget",
        unless: "size=invisible",
        hosts: ["google.com", "recaptcha.net"],
      },
      {
        value: "/recaptcha/api2/bframe",
        source: "observed",
        note: "reCAPTCHA challenge popup iframe",
        role: "challenge",
        hosts: ["google.com", "recaptcha.net"],
      },
      {
        value: "/recaptcha/enterprise/bframe",
        source: "observed",
        note: "reCAPTCHA enterprise challenge popup iframe",
        role: "challenge",
        hosts: ["google.com", "recaptcha.net"],
      },
    ],
    scripts: [
      {
        value: "google.com/recaptcha/",
        source: "documented",
        note: "Google reCAPTCHA v2 display guide",
      },
      { value: "recaptcha.net/recaptcha/", source: "observed", note: "alternate reCAPTCHA host" },
    ],
    selectors: [
      {
        value: ".g-recaptcha",
        source: "documented",
        note: "Google reCAPTCHA v2 display guide",
        role: "presence",
      },
    ],
  },
  {
    id: "hcaptcha",
    vendor: "hCaptcha",
    autoPassPlausible: false,
    iframes: [
      { value: "hcaptcha.com", source: "observed", note: "hCaptcha frame host", role: "presence" },
      {
        value: "#frame=checkbox",
        source: "observed",
        note: "hCaptcha checkbox frame",
        role: "widget",
        hosts: ["hcaptcha.com"],
      },
      {
        value: "#frame=challenge",
        source: "observed",
        note: "hCaptcha challenge frame",
        role: "challenge",
        hosts: ["hcaptcha.com"],
      },
    ],
    scripts: [
      { value: "hcaptcha.com/1/api.js", source: "documented", note: "hCaptcha developer guide" },
    ],
    selectors: [
      {
        value: ".h-captcha",
        source: "documented",
        note: "hCaptcha developer guide",
        role: "presence",
      },
    ],
  },
  {
    id: "datadome",
    vendor: "DataDome",
    autoPassPlausible: false,
    statuses: [403, 429, 503],
    blockPage: { statuses: [403, 429, 503], anyVendorMarker: true },
    iframes: [
      {
        value: "geo.captcha-delivery.com/captcha",
        source: "observed",
        note: "DataDome CAPTCHA frame",
        role: "challenge",
      },
    ],
    scripts: [
      { value: "captcha-delivery.com", source: "observed", note: "DataDome delivery host" },
    ],
    urls: [{ value: "/interstitial", source: "heuristic", note: "generic interstitial path" }],
  },
  {
    id: "human",
    vendor: "HUMAN/PerimeterX",
    autoPassPlausible: false,
    statuses: [403, 429],
    blockPage: { statuses: [403, 429], anyVendorMarker: true },
    scripts: [
      {
        value: "px-cloud.net",
        source: "observed",
        note: "HUMAN sensor host; script alone is advisory",
      },
    ],
    selectors: [
      {
        value: "#px-captcha",
        source: "observed",
        note: "PerimeterX CAPTCHA container",
        role: "challenge",
      },
    ],
  },
  {
    id: "akamai",
    vendor: "Akamai",
    autoPassPlausible: false,
    statuses: [403],
    blockPage: {
      statuses: [403],
      allOf: {
        titles: ["Access Denied"],
        text: ["You don't have permission to access", "Reference #"],
      },
    },
    titles: [
      {
        value: "Access Denied",
        source: "observed",
        note: "Akamai block-page title; generic without status and copy",
      },
    ],
    text: [
      {
        value: "You don't have permission to access",
        source: "observed",
        note: "Akamai block-page copy",
      },
      { value: "Reference #", source: "observed", note: "Akamai block-page reference" },
    ],
  },
  {
    id: "aws_waf",
    vendor: "AWS WAF",
    autoPassPlausible: false,
    statuses: [405],
    blockPage: { statuses: [405], anyVendorMarker: true },
    headers: [
      {
        name: "x-amzn-waf-action",
        value: "captcha",
        source: "documented",
        note: "AWS WAF CAPTCHA and Challenge action behavior",
      },
    ],
    scripts: [
      { value: "captcha.awswaf.com", source: "observed", note: "AWS WAF CAPTCHA script" },
      {
        value: "token.awswaf.com",
        source: "observed",
        note: "AWS WAF token script; advisory alone",
      },
    ],
  },
  {
    id: "imperva",
    vendor: "Imperva/Incapsula",
    autoPassPlausible: false,
    statuses: [403, 429],
    blockPage: { statuses: [403, 429], anyVendorMarker: true },
    scripts: [
      {
        value: "_Incapsula_Resource",
        source: "observed",
        note: "Imperva protection script; advisory alone",
      },
    ],
    text: [
      {
        value: "Request unsuccessful. Incapsula incident ID",
        source: "observed",
        note: "Imperva block-page copy",
      },
    ],
  },
  {
    id: "geetest",
    vendor: "GeeTest",
    autoPassPlausible: false,
    scripts: [{ value: "static.geetest.com", source: "observed", note: "GeeTest static assets" }],
    selectors: [
      {
        value: "[class*='geetest_']",
        source: "observed",
        note: "GeeTest widget class prefix",
        role: "widget",
      },
    ],
    text: [{ value: "拖动滑块", source: "heuristic", note: "generic slider instruction" }],
  },
  {
    id: "aliyun",
    vendor: "Aliyun",
    autoPassPlausible: false,
    statuses: [403, 429],
    blockPage: { statuses: [403, 429], anyVendorMarker: true },
    urls: [{ value: "/_____tmd_____/punish", source: "observed", note: "Aliyun punishment path" }],
    iframes: [
      {
        value: "/_____tmd_____/punish",
        source: "observed",
        note: "Aliyun (baxia) punishment dialog frame over the page",
        role: "challenge",
      },
    ],
    scripts: [{ value: "g.alicdn.com/AWSC", source: "observed", note: "Aliyun AWSC script" }],
    selectors: [
      { value: "#nc_1_n1z", source: "observed", note: "Aliyun slider handle", role: "widget" },
      {
        value: ".nc-container",
        source: "observed",
        note: "Aliyun slider container",
        role: "widget",
      },
      { value: "[id^='nc_']", source: "heuristic", note: "broad nc_ ID prefix" },
    ],
  },
  {
    id: "tencent",
    vendor: "Tencent TCaptcha",
    autoPassPlausible: false,
    iframes: [
      {
        value: "turing.captcha.qcloud.com",
        source: "observed",
        note: "Tencent CAPTCHA frame host",
        role: "challenge",
      },
      {
        value: "t.captcha.qq.com",
        source: "observed",
        note: "Tencent CAPTCHA frame host",
        role: "challenge",
      },
    ],
    selectors: [
      {
        value: "#tcaptcha_iframe_dy",
        source: "observed",
        note: "Tencent challenge iframe ID",
        role: "challenge",
      },
      { value: "#TCaptcha", source: "heuristic", note: "application-defined container ID" },
    ],
  },
  {
    id: "yidun",
    vendor: "NetEase Yidun",
    autoPassPlausible: false,
    scripts: [{ value: "cstaticdun.126.net", source: "observed", note: "Yidun static assets" }],
    selectors: [
      { value: ".yidun_popup", source: "observed", note: "Yidun popup", role: "challenge" },
      { value: ".yidun_slider", source: "observed", note: "Yidun slider", role: "widget" },
    ],
  },
  {
    id: "shumei",
    vendor: "Shumei",
    autoPassPlausible: false,
    scripts: [
      { value: "castatic.fengkongcloud.cn", source: "observed", note: "Shumei CAPTCHA assets" },
    ],
    selectors: [
      {
        value: ".shumei_captcha_wrapper",
        source: "observed",
        note: "Shumei widget wrapper",
        role: "widget",
      },
      {
        value: "[class*='fengkongcloud']",
        source: "heuristic",
        note: "broad host-like class substring",
      },
    ],
  },
  {
    id: "dingxiang",
    vendor: "Dingxiang",
    autoPassPlausible: false,
    scripts: [{ value: "cdn.dingxiang-inc.com", source: "observed", note: "Dingxiang CDN" }],
    selectors: [
      { value: "#dx_captcha", source: "observed", note: "Dingxiang widget", role: "widget" },
      { value: ".dx_captcha", source: "observed", note: "Dingxiang widget", role: "widget" },
      {
        value: "[class*='dingxiang']",
        source: "heuristic",
        note: "broad vendor-name class substring",
      },
    ],
  },
  {
    id: "bytedance",
    vendor: "ByteDance",
    autoPassPlausible: false,
    iframes: [
      {
        value: "verify.snssdk.com",
        source: "observed",
        note: "ByteDance verification frame",
        role: "challenge",
      },
      {
        value: "verify.zijieapi.com",
        source: "observed",
        note: "ByteDance verification frame",
        role: "challenge",
      },
    ],
    selectors: [
      {
        value: "#captcha_container",
        source: "heuristic",
        note: "generic CAPTCHA container ID",
        role: "presence",
      },
    ],
  },
];
