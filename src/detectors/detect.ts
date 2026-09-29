import type { NavigationResult, PageEvents } from "../engine/types.ts";
import type { ActionResult } from "../executor/types.ts";
import type { Observation, ObservedElement } from "../observer/types.ts";
import {
  challengeSignatures,
  type ChallengeSignature,
  type SignatureMarker,
} from "./signatures.ts";

export type DetectorInput = {
  observation: Observation;
  navigation?: NavigationResult & { failure?: string };
  recentActions: ActionResult[];
  pendingDialog?: PageEvents["dialog"];
  events: { popups: PageEvents["popup"][]; downloads: PageEvents["download"][] };
  candidateAction?: Pick<ObservedElement, "role" | "name"> &
    Partial<Pick<ObservedElement, "tag" | "inputType">>;
};

export type Finding =
  | {
      kind: "challenge" | "protection_present";
      level: "blocking" | "advisory";
      evidence: string[];
      vendor: string;
      autoPassPlausible: boolean;
    }
  | {
      kind: "login_wall" | "login_form_present" | "no_progress";
      level: "blocking" | "advisory";
      evidence: string[];
    }
  | {
      kind: "required_empty";
      level: "advisory";
      evidence: string[];
      fields: { ref: string; label: string; type: string; required: boolean }[];
    }
  | { kind: "error_page"; level: "blocking"; evidence: string[]; status?: number }
  | { kind: "irreversible"; level: "gate"; evidence: string[]; matched: string }
  | { kind: "dialog"; level: "blocking"; evidence: string[]; dialog: PageEvents["dialog"] }
  | { kind: "popup"; level: "advisory"; evidence: string[]; popup: PageEvents["popup"] }
  | { kind: "download"; level: "advisory"; evidence: string[]; download: PageEvents["download"] };

export const MIN_VISIBLE_CHALLENGE_SIZE = 16;

const englishTerms = [
  "submit order",
  "place order",
  "confirm order",
  "confirm payment",
  "remove account",
  "remove item",
  "buy",
  "purchase",
  "pay",
  "checkout",
  "delete",
  "publish",
  "transfer",
];
const chineseTerms = [
  "立即购买",
  "购买",
  "确认支付",
  "支付",
  "付款",
  "结算",
  "提交订单",
  "确认订单",
  "删除",
  "注销",
  "发布",
  "发送",
  "转账",
  "下单",
];
const chineseExclusions = [
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
  "查看删除记录",
  "支付方式",
  "付款方式",
];

export function detectorMarkerSelectors(): string[] {
  return [
    ...new Set(
      challengeSignatures.flatMap(
        (signature) => signature.selectors?.map((marker) => marker.value) ?? [],
      ),
    ),
  ];
}

function matchingMarkers(value: string, markers: SignatureMarker[]): SignatureMarker[] {
  return markers.filter((marker) => {
    if (!value.toLowerCase().includes(marker.value.toLowerCase())) return false;
    if (!marker.hosts) return true;
    try {
      const host = new URL(value).hostname.toLowerCase();
      return marker.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  });
}

function challengeFinding(
  input: DetectorInput,
  signature: ChallengeSignature,
): Finding | undefined {
  const { observation, navigation } = input;
  const markers = observation.signals.markers;
  const evidence: string[] = [];
  let documentedHeader = false;
  let dedicatedChallengeUrl = false;
  let vendorResource = false;
  let visibleChallenge = false;
  let vendorMarker = false;
  let interstitialCopy = false;
  let presence = false;
  const record = (kind: string, value: string, marker: SignatureMarker): void => {
    evidence.push(`${kind} ${value} [${marker.source}: ${marker.note}]`);
  };
  for (const marker of signature.headers ?? []) {
    const actual = Object.entries(navigation?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === marker.name.toLowerCase(),
    )?.[1];
    if (actual?.toLowerCase().includes(marker.value.toLowerCase())) {
      record(`header ${marker.name}:`, actual, marker);
      if (marker.source === "documented") documentedHeader = true;
      if (marker.source !== "heuristic") vendorMarker = true;
    }
  }
  const pageUrl = navigation?.url ?? observation.url;
  for (const marker of matchingMarkers(pageUrl, signature.urls ?? [])) {
    record("url", pageUrl, marker);
    if (marker.source !== "heuristic") vendorMarker = true;
    if (marker.source !== "heuristic" && marker.role === "challenge") dedicatedChallengeUrl = true;
  }
  for (const marker of matchingMarkers(observation.title, signature.titles ?? [])) {
    record("title", marker.value, marker);
    if (marker.source !== "heuristic") interstitialCopy = true;
  }
  for (const marker of matchingMarkers(observation.text, signature.text ?? [])) {
    record("text", marker.value, marker);
    if (marker.source !== "heuristic") interstitialCopy = true;
  }
  for (const match of markers?.scripts ?? [])
    for (const marker of matchingMarkers(match.url, signature.scripts ?? [])) {
      record("script", match.url, marker);
      if (marker.source !== "heuristic") {
        presence = true;
        vendorResource = true;
        vendorMarker = true;
      }
    }
  for (const match of markers?.iframes ?? [])
    for (const marker of matchingMarkers(match.url, signature.iframes ?? [])) {
      record("iframe", match.url, marker);
      if (marker.source !== "heuristic") {
        presence = true;
        vendorResource = true;
        vendorMarker = true;
        if (
          match.visible &&
          match.rect.width >= MIN_VISIBLE_CHALLENGE_SIZE &&
          match.rect.height >= MIN_VISIBLE_CHALLENGE_SIZE &&
          !(marker.unless && match.url.toLowerCase().includes(marker.unless.toLowerCase())) &&
          (marker.role === "widget" || marker.role === "challenge")
        )
          visibleChallenge = true;
      }
    }
  for (const match of markers?.selectorMatches ?? [])
    for (const marker of (signature.selectors ?? []).filter(
      (item) => item.value === match.selector,
    )) {
      record("selector", match.selector, marker);
      if (marker.source !== "heuristic") {
        presence = true;
        vendorMarker = true;
        if (
          match.visible &&
          match.rect.width >= MIN_VISIBLE_CHALLENGE_SIZE &&
          match.rect.height >= MIN_VISIBLE_CHALLENGE_SIZE &&
          (marker.role === "widget" || marker.role === "challenge")
        )
          visibleChallenge = true;
      }
    }
  if (evidence.length === 0) return undefined;
  const blockPage = signature.blockPage;
  const blockStatus =
    navigation?.status !== undefined && blockPage?.statuses.includes(navigation.status) === true;
  const blockCopy =
    blockPage?.allOf !== undefined &&
    (blockPage.allOf.titles ?? []).every((part) =>
      observation.title.toLowerCase().includes(part.toLowerCase()),
    ) &&
    (blockPage.allOf.text ?? []).every((part) =>
      observation.text.toLowerCase().includes(part.toLowerCase()),
    ) &&
    (blockPage.anyOf?.text === undefined ||
      blockPage.anyOf.text.some((part) =>
        observation.text.toLowerCase().includes(part.toLowerCase()),
      ));
  if (blockStatus) evidence.push(`status ${navigation.status}`);
  const blocking =
    documentedHeader ||
    dedicatedChallengeUrl ||
    visibleChallenge ||
    (blockPage?.copyOnly === true && blockCopy) ||
    (blockStatus && ((blockPage?.anyVendorMarker === true && vendorMarker) || blockCopy)) ||
    (interstitialCopy && vendorResource);
  if (!blocking && !presence) return undefined;
  return {
    kind: blocking ? "challenge" : "protection_present",
    level: blocking ? "blocking" : "advisory",
    evidence,
    vendor: signature.vendor,
    autoPassPlausible: signature.autoPassPlausible,
  };
}

export function irreversibleMatch(rawName: string): string | undefined {
  const name = rawName.trim().toLowerCase();
  if (name === "post" || name === "send" || /^send\s+(?!code\b|verification\s+code\b)/iu.test(name))
    return name === "post" ? "post" : "send";
  for (const term of englishTerms) {
    const expression = new RegExp(`(?:^|[^a-z])${term.replaceAll(" ", "\\s+")}(?:$|[^a-z])`, "iu");
    if (expression.test(name)) return term;
  }
  for (const term of chineseTerms) {
    let start = name.indexOf(term);
    while (start !== -1) {
      const end = start + term.length;
      const excluded = chineseExclusions.some((phrase) => {
        let exclusionStart = name.indexOf(phrase);
        while (exclusionStart !== -1) {
          if (start >= exclusionStart && end <= exclusionStart + phrase.length) return true;
          exclusionStart = name.indexOf(phrase, exclusionStart + 1);
        }
        return false;
      });
      if (!excluded) return term;
      start = name.indexOf(term, start + 1);
    }
  }
  return undefined;
}

export function irreversibleActionMatch(
  item: Pick<ObservedElement, "role" | "name"> &
    Partial<Pick<ObservedElement, "tag" | "inputType">>,
): string | undefined {
  const submitInput = item.tag === "input" && ["submit", "image"].includes(item.inputType ?? "");
  const control =
    item.role === "button" || item.role === "menuitem" || item.tag === "button" || submitInput;
  if (!control && item.role !== "link") return undefined;
  if (item.role === "link" && !control) {
    const words = item.name.trim().split(/\s+/u);
    const cjk = [...item.name.matchAll(/[\p{Script=Han}]/gu)].length;
    if (cjk > 12 || words.length > 5) return undefined;
  }
  return irreversibleMatch(item.name);
}

export function detect(input: DetectorInput): Finding[] {
  const { observation, navigation } = input;
  const findings: Finding[] = [];
  for (const signature of challengeSignatures) {
    const finding = challengeFinding(input, signature);
    if (finding) findings.push(finding);
  }
  const password =
    observation.signals.passwordFieldVisible ||
    observation.elements.some((element) => element.inputType === "password" && element.inViewport);
  const pageUrl = navigation?.url ?? observation.url;
  let loginPath = pageUrl;
  try {
    const parsed = new URL(pageUrl);
    loginPath = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    /* Navigation failure URLs may not be parseable. */
  }
  const loginUrl =
    /(?:^|[/?#._-])(?:login|log-in|signin|sign-in|passport|auth)(?:[/?#._-]|$)/iu.test(loginPath);
  if (password || loginUrl || observation.signals.loginTextPanel) {
    const blocking =
      observation.signals.loginTextModal === true ||
      (password &&
        (loginUrl ||
          observation.signals.loginModalCoversViewport === true ||
          observation.signals.mainLoginFormOnly === true));
    findings.push({
      kind: blocking ? "login_wall" : "login_form_present",
      level: blocking ? "blocking" : "advisory",
      evidence: [
        ...(password ? ["visible password field"] : []),
        ...(loginUrl ? [`login URL ${pageUrl}`] : []),
        ...(observation.signals.loginModalCoversViewport ? ["viewport-covering login dialog"] : []),
        ...(observation.signals.mainLoginFormOnly ? ["main content is login form"] : []),
        ...(observation.signals.loginTextModal ? ["login markers in modal"] : []),
        ...(observation.signals.loginTextPanel ? ["login markers in page content"] : []),
      ],
    });
  }
  const active = observation.forms.find((form) => form.active);
  const fields = (active?.fields ?? [])
    .filter((field) => field.required && field.empty)
    .flatMap((field) => {
      const element = observation.elements.find((item) => item.ref === field.ref);
      return element
        ? [
            {
              ref: field.ref,
              label: element.name,
              type: element.inputType ?? element.role,
              required: true,
            },
          ]
        : [];
    });
  if (fields.length)
    findings.push({
      kind: "required_empty",
      level: "advisory",
      evidence: fields.map((field) => `required empty ${field.ref}`),
      fields,
    });
  const status = navigation?.status;
  const errorEvidence = [
    ...(status !== undefined && status >= 400 ? [`status ${status}`] : []),
    ...(/^chrome-error:\/\//u.test(pageUrl) || /^chrome-error:\/\//u.test(observation.url)
      ? ["chrome-error URL"]
      : []),
    ...(navigation?.failure ? [`navigation failure: ${navigation.failure}`] : []),
  ];
  if (errorEvidence.length)
    findings.push({
      kind: "error_page",
      level: "blocking",
      evidence: errorEvidence,
      ...(status !== undefined && status >= 400 ? { status } : {}),
    });
  const [previous, latest] = input.recentActions.slice(-2);
  if (
    previous &&
    latest &&
    ((previous.outcome === "stale" && latest.outcome === "stale") ||
      (["unchanged", "covered", "disabled", "invisible", "select-failed"].includes(
        previous.outcome,
      ) &&
        latest.outcome === previous.outcome &&
        previous.pageHash !== undefined &&
        previous.pageHash === latest.pageHash &&
        previous.pageHash === observation.pageHash &&
        previous.url === latest.url &&
        latest.url === observation.url))
  )
    findings.push({
      kind: "no_progress",
      level: "blocking",
      evidence: [`${previous.outcome}, ${latest.outcome} on ${observation.pageHash}`],
    });
  if (input.candidateAction) {
    const matched = irreversibleActionMatch(input.candidateAction);
    if (matched)
      findings.push({
        kind: "irreversible",
        level: "gate",
        evidence: [`action name ${input.candidateAction.name}`],
        matched,
      });
  }
  if (input.pendingDialog)
    findings.push({
      kind: "dialog",
      level: "blocking",
      evidence: [`${input.pendingDialog.kind} dialog`],
      dialog: input.pendingDialog,
    });
  for (const popup of input.events.popups)
    findings.push({ kind: "popup", level: "advisory", evidence: [`popup ${popup.id}`], popup });
  for (const download of input.events.downloads)
    findings.push({
      kind: "download",
      level: "advisory",
      evidence: [`download ${download.url}`],
      download,
    });
  return findings;
}

const blockingPrecedence: Partial<Record<Finding["kind"], number>> = {
  challenge: 0,
  error_page: 1,
  login_wall: 2,
  dialog: 3,
  no_progress: 4,
};

export function orderFindings(findings: Finding[]): Finding[] {
  const levelOrder = { blocking: 0, advisory: 1, gate: 2 };
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (left, right) =>
        levelOrder[left.finding.level] - levelOrder[right.finding.level] ||
        (left.finding.level === "blocking"
          ? (blockingPrecedence[left.finding.kind] ?? 99) -
            (blockingPrecedence[right.finding.kind] ?? 99)
          : 0) ||
        left.index - right.index,
    )
    .map(({ finding }) => finding);
}
