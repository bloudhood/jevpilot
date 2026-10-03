import type {
  Observation,
  ObservedIframe,
  ObservedScript,
  Rect,
  RefResolution,
  SelectorMatch,
  SnapshotOptions,
} from "./types.ts";
import type { PageHandle } from "../engine/types.ts";
import { FrameGoneError } from "../engine/types.ts";
import { installObserverLibrary } from "./page-library.ts";
import { mapFramePoint, mapFrameRect } from "./frame-geometry.ts";
import type { ObserverPageLibrary } from "./page-library.ts";

export function pageSnapshot(options: SnapshotOptions): Omit<Observation, "timings"> {
  const global = globalThis as typeof globalThis & {
    __jevpilotObserverLibrary?: ObserverPageLibrary;
    __jevpilotObserverRegistry?: {
      epoch: number;
      refs: Map<string, WeakRef<Element>>;
      locations: Map<
        string,
        {
          framePath: string;
          offsetX: number;
          offsetY: number;
          containerText?: string;
          itemPosition?: number;
          itemCount?: number;
        }
      >;
      identities: Map<string, { role: string; name: string; formId: string; fingerprint: string }>;
    };
  };
  const registry = global.__jevpilotObserverRegistry ?? {
    epoch: 0,
    refs: new Map<string, WeakRef<Element>>(),
    locations: new Map(),
    identities: new Map(),
  };
  global.__jevpilotObserverRegistry = registry;
  registry.epoch++;
  registry.refs.clear();
  registry.locations.clear();
  registry.identities ??= new Map();
  registry.identities.clear();
  const epoch = registry.epoch;
  const documentRoot = document.documentElement;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const collectionBottom = height * (1 + Math.max(0, options.belowFoldScreens ?? 1));
  const elements: Observation["elements"] = [];
  const forms = new Map<string, Observation["forms"][number]>();
  const iframeOrigins: string[] = [];
  const scriptOrigins: string[] = [];
  let markerScanMs = 0;
  const selectorMatches: SelectorMatch[] = [];
  const iframes: ObservedIframe[] = [];
  const scripts: ObservedScript[] = [];
  const scriptCounts = new Map<string, number>();
  const library = global.__jevpilotObserverLibrary!;
  const {
    clean,
    rectOf,
    visible,
    markerVisible,
    composedText,
    composedElements,
    composedParent,
    composedClosest,
    roleOf,
    nameOf,
    iconHint,
    formOf,
    hash,
  } = library;
  const containerSiblings = new WeakMap<Element, Element[]>();
  const containerSelector =
    'li, tr, article, [class*="card" i], [class~="inventory_item"], [class*="product-item" i], [class*="product_item" i], [data-testid*="card" i], [data-testid*="product" i]';
  const paginationContainer = (element: Element): boolean =>
    Boolean(
      element.closest(
        '[class*="pagin" i], [id*="pagin" i], [aria-label*="pagin" i], nav[aria-label*="page" i]',
      ),
    );
  const isPagination = (element: Element): boolean => {
    const tag = element.localName;
    if (
      tag !== "a" &&
      tag !== "button" &&
      !["link", "button"].includes(element.getAttribute("role") ?? "")
    )
      return false;
    if (/\b(?:next|prev)\b/iu.test(element.getAttribute("rel") ?? "")) return true;
    if (/(?:next|previous|下一页|上一页)/iu.test(element.getAttribute("aria-label") ?? ""))
      return true;
    if (/(?:[?&](?:page|p)=\d+|\/page\/\d+)(?:\b|\/|$)/iu.test(element.getAttribute("href") ?? ""))
      return true;
    const name = clean(element.textContent);
    if (
      /^(?:next|previous|prev|more|load more|older|newer|更多|加载更多|下一页|上一页|下页|上页|›|»|→|‹|«|←)$/iu.test(
        name,
      )
    )
      return true;
    return /^\d+$/u.test(name) && paginationContainer(element);
  };
  let focusedForm: string | undefined;
  const visit = (
    root: Document | ShadowRoot,
    framePath: string,
    offsetX: number,
    offsetY: number,
  ): void => {
    const markerStarted = globalThis.performance?.now() ?? Date.now();
    for (const selector of options.markerSelectors ?? []) {
      for (const matched of root.querySelectorAll(selector)) {
        const rect = rectOf(matched, offsetX, offsetY);
        selectorMatches.push({
          selector,
          framePath,
          visible: markerVisible(matched, rect),
          rect,
        });
      }
    }
    markerScanMs += (globalThis.performance?.now() ?? Date.now()) - markerStarted;
    for (const element of root.querySelectorAll("*")) {
      const rect = rectOf(element, offsetX, offsetY);
      if (element.localName === "iframe") {
        const frame = element as HTMLIFrameElement;
        const origin = (() => {
          try {
            return new URL(frame.src, location.href).origin;
          } catch {
            return "unknown";
          }
        })();
        iframeOrigins.push(origin);
        const rules = options.adFrameRules;
        const adFrame =
          rules &&
          ([frame.name, frame.id].some(
            (name) =>
              name &&
              (rules.names.includes(name) ||
                rules.namePrefixes.some((prefix) => name.startsWith(prefix))),
          ) ||
            (() => {
              try {
                const host = new URL(frame.src, location.href).hostname.toLowerCase();
                return (
                  rules.exactHosts.includes(host) ||
                  rules.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
                );
              } catch {
                return false;
              }
            })());
        if (frame.src || adFrame) {
          iframes.push({
            url: frame.src || "about:blank",
            framePath,
            visible: markerVisible(element, rect),
            rect,
          });
        }
        if (adFrame) continue;
        try {
          if (options.traverseFrames !== false && frame.contentDocument) {
            visit(
              frame.contentDocument,
              `${framePath}frame${elements.length + 1}/`,
              rect.x,
              rect.y,
            );
            continue;
          }
        } catch {
          /* Cross-origin access is expected. */
        }
        if (visible(element, rect)) add(element, "frame", origin, rect, framePath);
        continue;
      }
      if (element.localName === "script") {
        const source = (element as HTMLScriptElement).src;
        if (source && (scriptCounts.get(framePath) ?? 0) < 200) {
          scripts.push({ url: source, framePath });
          scriptCounts.set(framePath, (scriptCounts.get(framePath) ?? 0) + 1);
        }
        if (source && scriptOrigins.length < 30) {
          try {
            scriptOrigins.push(new URL(source).origin);
          } catch {
            /* Invalid source. */
          }
        }
      }
      const nearViewport =
        rect.y + rect.height >= 0 &&
        rect.y <= collectionBottom &&
        rect.x + rect.width >= 0 &&
        rect.x <= width;
      const formField =
        ["input", "select", "textarea"].includes(element.localName) ||
        ["textbox", "combobox", "checkbox", "radio"].includes(element.getAttribute("role") ?? "");
      const pagination = isPagination(element);
      if (!nearViewport && !formField && !pagination) {
        if (element.shadowRoot) visit(element.shadowRoot, framePath, offsetX, offsetY);
        continue;
      }
      const { role, type } = roleOf(element);
      if (role && role !== "hidden" && visible(element, rect))
        add(element, role, nameOf(element), rect, framePath, type, pagination);
      if (element.shadowRoot) visit(element.shadowRoot, framePath, offsetX, offsetY);
    }
  };
  const add = (
    element: Element,
    role: string,
    name: string,
    rect: Rect,
    framePath: string,
    inputType?: string,
    pagination = false,
  ): void => {
    const container =
      element.closest?.(containerSelector) ?? composedClosest(element, containerSelector);
    const containerParent = container ? composedParent(container) : null;
    const siblings = containerParent
      ? (containerSiblings.get(containerParent) ??
        (() => {
          const items = [...containerParent.children].filter((candidate) =>
            candidate.matches(containerSelector),
          );
          containerSiblings.set(containerParent, items);
          return items;
        })())
      : [];
    const containerText =
      container && container !== element
        ? (() => {
            return composedText(container, 60, (node) => element.contains(node));
          })()
        : "";
    const ref = `e${elements.length + 1}`;
    const formId = formOf(element, framePath);
    const identityName = name;
    const nearbyName = name ? "" : library.nearbyNameOf(element);
    const fingerprint = hash(`${role}\u0000${identityName}\u0000${formId ?? ""}`);
    const input = element as HTMLInputElement;
    const autocomplete = element.getAttribute("autocomplete")?.toLowerCase() ?? "";
    const secret =
      element.localName === "input" &&
      (inputType === "password" ||
        /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[^\s]+)(?=\s|$)/u.test(
          autocomplete,
        ) ||
        /pass(?:word)?|pwd|otp|cvv|cvc/iu.test(
          `${element.getAttribute("name") ?? ""} ${element.id}`,
        ));
    const rawValue = secret
      ? input.value
        ? "***"
        : ""
      : (element as HTMLElement).isContentEditable && role === "textbox"
        ? (element as HTMLElement).innerText
        : input.value;
    const value = typeof rawValue === "string" ? clean(rawValue, 60) : undefined;
    const displayName =
      name && clean(element.getAttribute("placeholder")) === name && value
        ? ""
        : name || nearbyName;
    const hint =
      !name && ["button", "link", "clickable", "menuitem", "tab", "option"].includes(role)
        ? iconHint(element)
        : undefined;
    const empty = !value;
    const select = element.localName === "select" ? (element as HTMLSelectElement) : undefined;
    const clientRects = [
      ...(element.getClientRects?.() ?? [element.getBoundingClientRect()]),
    ].filter((client) => client.width > 0 && client.height > 0);
    const clickClientRect =
      role === "link" && getComputedStyle(element).display === "inline"
        ? clientRects[0]
        : clientRects.sort(
            (left, right) => right.width * right.height - left.width * left.height,
          )[0];
    const clickRect = clickClientRect
      ? {
          x: clickClientRect.x + rect.x - element.getBoundingClientRect().x,
          y: clickClientRect.y + rect.y - element.getBoundingClientRect().y,
          width: clickClientRect.width,
          height: clickClientRect.height,
        }
      : rect;
    const optionLabels = select
      ? [...select.options].slice(0, 20).map((option) => clean(option.label))
      : undefined;
    const item: Observation["elements"][number] = {
      ref,
      framePath,
      origin: location.origin,
      fingerprint,
      role,
      name: displayName,
      ...(hint ? { iconHint: hint } : {}),
      identityName,
      nameSource: nearbyName ? "nearby" : "spec",
      tag: element.localName,
      checked: Boolean(input.checked || element.getAttribute("aria-checked") === "true"),
      selected: Boolean(
        (element as HTMLOptionElement).selected || element.getAttribute("aria-selected") === "true",
      ),
      disabled: Boolean(input.disabled || element.getAttribute("aria-disabled") === "true"),
      readonly: Boolean(input.readOnly || element.getAttribute("aria-readonly") === "true"),
      required: Boolean(input.required || element.getAttribute("aria-required") === "true"),
      invalid: element.getAttribute("aria-invalid") === "true",
      rect,
      clickRect,
      inViewport:
        rect.y + rect.height > 0 && rect.y < height && rect.x + rect.width > 0 && rect.x < width,
      distanceBelowFold: Math.max(0, rect.y - height),
      ...(inputType ? { inputType } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(element.getAttribute("placeholder")
        ? { placeholder: clean(element.getAttribute("placeholder")) }
        : {}),
      ...(formId ? { formId } : {}),
      ...(element.localName === "a" ? { href: element.getAttribute("href") ?? "" } : {}),
      ...(element.getAttribute("rel") ? { rel: element.getAttribute("rel") ?? "" } : {}),
      ...(element.getAttribute("aria-label")
        ? { ariaLabel: element.getAttribute("aria-label") ?? "" }
        : {}),
      ...(pagination && /^\d+$/u.test(name) && paginationContainer(element)
        ? { paginationContainer: true }
        : {}),
      ...(pagination ? { pagination: true } : {}),
      ...(select
        ? {
            options: optionLabels ?? [],
            optionCount: select.options.length,
            optionLabel: clean(select.selectedOptions[0]?.label),
          }
        : {}),
      ...(element.closest("header")
        ? { landmark: "header" as const }
        : element.closest("nav")
          ? { landmark: "nav" as const }
          : {}),
      ...(containerText ? { containerText } : {}),
      ...(container && siblings.length
        ? { itemPosition: siblings.indexOf(container) + 1, itemCount: siblings.length }
        : {}),
    };
    elements.push(item);
    registry.refs.set(ref, new WeakRef(element));
    registry.identities.set(ref, { role, name: identityName, formId: formId ?? "", fingerprint });
    registry.locations.set(ref, {
      framePath,
      offsetX: rect.x - element.getBoundingClientRect().x,
      offsetY: rect.y - element.getBoundingClientRect().y,
      ...(containerText ? { containerText } : {}),
      ...(siblings.length
        ? { itemPosition: siblings.indexOf(container!) + 1, itemCount: siblings.length }
        : {}),
    });
    if (
      formId &&
      (role === "input" ||
        role === "textarea" ||
        role === "select" ||
        role === "textbox" ||
        role === "combobox" ||
        role === "checkbox" ||
        role === "radio")
    ) {
      const form = forms.get(formId) ?? { id: formId, active: false, fields: [] };
      form.fields.push({ ref, required: item.required, empty });
      forms.set(formId, form);
      if (element === (element.getRootNode() as Document | ShadowRoot).activeElement)
        focusedForm = formId;
    }
  };
  visit(document, "", 0, 0);
  const formList = [...forms.values()];
  const active =
    focusedForm ??
    formList.sort(
      (left, right) =>
        right.fields.filter((field) => elements.find((item) => item.ref === field.ref)?.inViewport)
          .length -
        left.fields.filter((field) => elements.find((item) => item.ref === field.ref)?.inViewport)
          .length,
    )[0]?.id;
  for (const form of formList) form.active = form.id === active;
  const content = document.querySelector("main, article, [role=main]") ?? document.body;
  const textRoot = content && composedText(content, 1).length ? content : document.body;
  const textParts: string[] = [];
  const scanLimit = options.textScanChars ?? options.maxTextChars;
  if (textRoot) textParts.push(composedText(textRoot, scanLimit));
  const text = clean(
    textParts.join("\n"),
    Math.max(0, options.textScanChars ?? options.maxTextChars),
  );
  const headings = composedElements(document)
    .filter((element) => /^(?:h1|h2|h3)$/u.test(element.localName))
    .filter((element) => visible(element, rectOf(element)))
    .slice(0, 15)
    .map((element) => ({ level: Number(element.localName[1]), text: composedText(element, 80) }));
  const pageElements = composedElements(document.body ?? document);
  const modalOverlay = pageElements.some((element) => {
    const rect = rectOf(element);
    if (
      rect.width * rect.height <= width * height * 0.5 ||
      rect.y >= height ||
      rect.x >= width ||
      rect.y + rect.height <= 0 ||
      rect.x + rect.width <= 0
    )
      return false;
    const style = getComputedStyle(element);
    if (style.position !== "fixed" && style.position !== "absolute") return false;
    return visible(element, rect) && Number(style.zIndex) > 0;
  });
  const loginMarkers = [
    "扫码登录",
    "验证码登录",
    "手机号登录",
    "短信登录",
    "密码登录",
    "登录后查看",
    "Sign in",
    "Log in",
  ];
  const hasLoginMarker = (value: string): boolean =>
    loginMarkers.some((marker) => value.toLowerCase().includes(marker.toLowerCase()));
  const loginTextPanel = hasLoginMarker(composedText(document.body ?? document, 20_000));
  const loginOverlay = pageElements.some((element) => {
    const rect = rectOf(element);
    const style = getComputedStyle(element);
    return (
      rect.width * rect.height >= width * height * 0.9 &&
      (style.position === "fixed" || style.position === "absolute") &&
      Number(style.zIndex) > 0 &&
      visible(element, rect)
    );
  });
  const loginTextModal = pageElements.some((element) => {
    const rect = rectOf(element);
    const style = getComputedStyle(element);
    let semanticModal = element.matches('[aria-modal="true"]');
    if (element.localName === "dialog" && (element as HTMLDialogElement).open) {
      try {
        semanticModal ||= (element as HTMLDialogElement).matches(":modal");
      } catch {
        semanticModal = true;
      }
    }
    const viewportOverlay =
      rect.width * rect.height >= width * height * 0.9 &&
      (style.position === "fixed" || style.position === "absolute") &&
      Number(style.zIndex) > 0;
    const panelOverOverlay =
      loginOverlay &&
      (style.position === "fixed" || style.position === "absolute") &&
      Number(style.zIndex) > 0;
    return (
      (semanticModal || viewportOverlay || panelOverOverlay) &&
      visible(element, rect) &&
      hasLoginMarker(composedText(element, 2000))
    );
  });
  const visiblePasswords = [...document.querySelectorAll('input[type="password"]')].filter(
    (element) => markerVisible(element, rectOf(element)),
  );
  const fullScreenOverlay = loginOverlay;
  const loginModalCoversViewport = visiblePasswords.some((password) => {
    const modal = password.closest('dialog[open], [aria-modal="true"]');
    if (modal && visible(modal, rectOf(modal))) {
      if (modal.localName !== "dialog") return true;
      try {
        if ((modal as HTMLDialogElement).matches(":modal")) return true;
      } catch {
        /* Older engines may not support the :modal selector. */
      }
    }
    if (!fullScreenOverlay) return false;
    let container = password.parentElement;
    while (container && container !== document.body) {
      const style = getComputedStyle(container);
      if (
        (style.position === "fixed" || style.position === "absolute") &&
        markerVisible(container, rectOf(container))
      )
        return true;
      container = container.parentElement;
    }
    return false;
  });
  const mainContent = document.querySelector("main, article, [role=main]");
  const loginContent = mainContent ?? document.body;
  const nonFormContent =
    loginContent && visiblePasswords.length > 0
      ? [...loginContent.querySelectorAll("h1, h2, h3, p, article, [role=main]")]
          .filter((element) => !element.closest("form"))
          .map((element) => clean(element.textContent, 200))
          .join(" ")
      : "";
  const mainLoginFormOnly = Boolean(
    loginContent &&
    visiblePasswords.some((password) => loginContent.contains(password)) &&
    loginContent.querySelector("form") &&
    clean(loginContent.textContent, 300).length < 180 &&
    nonFormContent.length < 20 &&
    loginContent.querySelectorAll("a[href]").length <= 2 &&
    (mainContent || !document.querySelector("header, nav, article")),
  );
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    epoch,
    viewport: { width, height },
    scroll: {
      x: documentRoot ? scrollX : 0,
      y: documentRoot ? scrollY : 0,
      maxY: documentRoot ? Math.max(0, documentRoot.scrollHeight - height) : 0,
    },
    elements,
    text,
    headings,
    forms: formList,
    signals: {
      passwordFieldVisible: elements.some(
        (element) => element.inputType === "password" && element.inViewport,
      ),
      loginModalCoversViewport,
      loginTextModal,
      loginTextPanel,
      mainLoginFormOnly,
      modalOverlay,
      dialogOpen: [
        ...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]'),
      ].some((element) => visible(element, rectOf(element))),
      iframeOrigins,
      scriptOrigins: [...new Set(scriptOrigins)],
      markers: {
        selectorMatches,
        iframes,
        scripts,
        scanMs: markerScanMs,
      },
    },
    pageHash: hash(
      `${location.href}\u0000${elements.map((element) => `${element.role}:${element.name}`).join("|")}\u0000${text}`,
    ),
  };
}

export function waitForNavigationQuiet(force = false): Promise<number> {
  const state = globalThis as typeof globalThis & {
    __jevpilotObservedLocation?: string;
  };
  const current = location.href;
  if (!force && state.__jevpilotObservedLocation === current) return Promise.resolve(0);
  state.__jevpilotObservedLocation = current;
  return new Promise((resolve) => {
    const started = performance.now();
    let lastMutation = started;
    let mutationSeen = false;
    const observers: MutationObserver[] = [];
    const observedRoots = new WeakSet<Node>();
    const attachAddedSubtree = (node: Node): void => {
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const element = node as Element;
      if (node.nodeType === 1 && element.shadowRoot) attach(element.shadowRoot);
      for (const descendant of element.querySelectorAll("*"))
        if (descendant.shadowRoot) attach(descendant.shadowRoot);
    };
    const attach = (root: Document | ShadowRoot): void => {
      if (!observedRoots.has(root)) {
        observedRoots.add(root);
        const observer = new MutationObserver((records) => {
          mutationSeen = true;
          lastMutation = performance.now();
          for (const record of records)
            for (const node of record.addedNodes) attachAddedSubtree(node);
        });
        observer.observe(root, {
          subtree: true,
          childList: true,
        });
        observers.push(observer);
      }
      for (const element of root.querySelectorAll("*"))
        if (element.shadowRoot) attach(element.shadowRoot);
    };
    attach(document);
    const check = (): void => {
      const now = performance.now();
      const quietFor = now - lastMutation;
      if (
        (!mutationSeen && now - started >= 50) ||
        (mutationSeen && quietFor >= 200) ||
        now - started >= 1500
      ) {
        for (const activeObserver of observers) activeObserver.disconnect();
        resolve(Math.round(now - started));
        return;
      }
      setTimeout(check, Math.min(50, mutationSeen ? 200 - quietFor : 50 - (now - started)));
    };
    setTimeout(check, 0);
  });
}

export function resolveRef(
  page: PageHandle,
  epoch: number,
  ref: string,
  fingerprint: string,
  precheck = false,
  strict = false,
): Promise<RefResolution> {
  if (ref.startsWith("frame:")) {
    const separator = ref.indexOf("/");
    const marker = ref.lastIndexOf("@", separator);
    const frameId = ref.slice(6, marker);
    const frameEpoch = Number(ref.slice(marker + 1, separator));
    return page.frames().then(async (frames) => {
      const frame = frames.find((item) => item.id === frameId);
      if (!frame) return { status: "missing" };
      const args: [number, string, string] = [frameEpoch, ref.slice(separator + 1), fingerprint];
      let result;
      try {
        await frame.callIsolated(installObserverLibrary, []);
        result = precheck
          ? await frame.callIsolated(resolveRefInPage, [...args, true, strict] as [
              number,
              string,
              string,
              boolean,
              boolean,
            ])
          : await frame.callIsolated(resolveRefInPage, args);
      } catch (error) {
        if (error instanceof FrameGoneError) return { status: "missing" };
        throw error;
      }
      return result.rect
        ? {
            ...result,
            rect: mapFrameRect(result.rect, frame.offset),
            ...(result.clickPoint
              ? {
                  clickPoint: mapFramePoint(result.clickPoint, frame.offset),
                }
              : {}),
          }
        : result;
    });
  }
  return page
    .callIsolated(installObserverLibrary, [])
    .then(() =>
      precheck
        ? page.callIsolated(resolveRefInPage, [epoch, ref, fingerprint, true, strict])
        : page.callIsolated(resolveRefInPage, [epoch, ref, fingerprint]),
    );
}

export async function locateRef(
  page: PageHandle,
  epoch: number,
  ref: string,
  fingerprint: string,
): Promise<RefResolution> {
  const resolve = (): Promise<RefResolution> => {
    if (ref.startsWith("frame:")) {
      const separator = ref.indexOf("/");
      const marker = ref.lastIndexOf("@", separator);
      const frameId = ref.slice(6, marker);
      return page.frames().then(async (frames) => {
        const frame = frames.find((item) => item.id === frameId);
        if (!frame) return { status: "missing" as const };
        try {
          await frame.callIsolated(installObserverLibrary, []);
        } catch (error) {
          if (error instanceof FrameGoneError) return { status: "missing" as const };
          throw error;
        }
        let result: RefResolution;
        try {
          result = await frame.callIsolated(resolveRefInPage, [
            Number(ref.slice(marker + 1, separator)),
            ref.slice(separator + 1),
            fingerprint,
            false,
            false,
          ] as [number, string, string, boolean, boolean]);
        } catch (error) {
          if (error instanceof FrameGoneError) return { status: "missing" as const };
          throw error;
        }
        return result.rect
          ? {
              ...result,
              rect: mapFrameRect(result.rect, frame.offset),
            }
          : result;
      });
    }
    return page
      .callIsolated(installObserverLibrary, [])
      .then(() => page.callIsolated(resolveRefInPage, [epoch, ref, fingerprint, false, false]));
  };
  const result = await resolve();
  if (result.status !== "ok" || !result.rect) return result;
  // Bring a partly off-screen element fully into the viewport, then resolve again: screenshots
  // clip to the viewport, unlike clicks.
  let offscreen: boolean;
  try {
    offscreen = await page.callIsolated(refOutsideViewport, [epoch, ref]);
  } catch {
    return result;
  }
  if (!offscreen) return result;
  try {
    await page.callIsolated(scrollRefIntoView, [epoch, ref]);
  } catch {
    return result;
  }
  return resolve();
}

function refOutsideViewport(epoch: number, ref: string): boolean {
  const registry = (
    globalThis as typeof globalThis & {
      __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
    }
  ).__jevpilotObserverRegistry;
  if (registry?.epoch !== epoch) return false;
  const element = registry.refs.get(ref)?.deref();
  if (!element?.isConnected) return false;
  const box = element.getBoundingClientRect();
  return box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight;
}

function scrollRefIntoView(epoch: number, ref: string): void {
  const registry = (
    globalThis as typeof globalThis & {
      __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
    }
  ).__jevpilotObserverRegistry;
  if (registry?.epoch !== epoch) return;
  const element = registry.refs.get(ref)?.deref();
  if (element?.isConnected) element.scrollIntoView({ block: "center", inline: "center" });
}

export function waitForRef(
  page: PageHandle,
  epoch: number,
  ref: string,
  fingerprint: string,
  kind: "click" | "toggle" | "select" | "type" | "submit",
  timeoutMs: number,
  strict = false,
  fastCoveredSubmit = false,
): Promise<RefResolution> {
  const args: [number, string, string, boolean, boolean, typeof kind, number, boolean] = [
    epoch,
    ref,
    fingerprint,
    true,
    strict,
    kind,
    timeoutMs,
    fastCoveredSubmit,
  ];
  if (ref.startsWith("frame:")) {
    const separator = ref.indexOf("/");
    const marker = ref.lastIndexOf("@", separator);
    const frameId = ref.slice(6, marker);
    return page.frames().then(async (frames) => {
      const frame = frames.find((item) => item.id === frameId);
      if (!frame) return { status: "missing", waitMs: 0 };
      let result;
      try {
        await frame.callIsolated(installObserverLibrary, []);
        result = await frame.callIsolated(
          resolveRefInPage as unknown as (
            epoch: number,
            ref: string,
            fingerprint: string,
            precheck: boolean,
            strict: boolean,
            actionKind: typeof kind,
            timeout: number,
            fastCoveredSubmit: boolean,
          ) => Promise<RefResolution>,
          [
            Number(ref.slice(marker + 1, separator)),
            ref.slice(separator + 1),
            fingerprint,
            true,
            strict,
            kind,
            timeoutMs,
            fastCoveredSubmit,
          ],
          { timeoutMs: timeoutMs + 1000 },
        );
      } catch (error) {
        if (error instanceof FrameGoneError) return { status: "missing", waitMs: 0 };
        throw error;
      }
      return result.rect
        ? {
            ...result,
            rect: mapFrameRect(result.rect, frame.offset),
            ...(result.clickPoint
              ? {
                  clickPoint: mapFramePoint(result.clickPoint, frame.offset),
                }
              : {}),
          }
        : result;
    });
  }
  return page
    .callIsolated(installObserverLibrary, [])
    .then(() =>
      page.callIsolated(
        resolveRefInPage as unknown as (
          epoch: number,
          ref: string,
          fingerprint: string,
          precheck: boolean,
          strict: boolean,
          actionKind: typeof kind,
          timeout: number,
          fastCoveredSubmit: boolean,
        ) => Promise<RefResolution>,
        args,
        { timeoutMs: timeoutMs + 1000 },
      ),
    );
}

export async function focusRef(page: PageHandle, epoch: number, ref: string): Promise<boolean> {
  if (ref.startsWith("frame:")) {
    const separator = ref.indexOf("/");
    const marker = ref.lastIndexOf("@", separator);
    const frame = (await page.frames()).find((item) => item.id === ref.slice(6, marker));
    if (!frame) return false;
    try {
      return await frame.callIsolated(focusRefInPage, [
        Number(ref.slice(marker + 1, separator)),
        ref.slice(separator + 1),
      ]);
    } catch (error) {
      if (!(error instanceof FrameGoneError)) throw error;
    }
    return false;
  }
  return page.callIsolated(focusRefInPage, [epoch, ref]);
}

export function focusRefInPage(epoch: number, ref: string): boolean {
  const global = globalThis as typeof globalThis & {
    __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
  };
  const registry = global.__jevpilotObserverRegistry;
  if (registry?.epoch !== epoch) return false;
  const element = registry.refs.get(ref)?.deref();
  if (!element?.isConnected || !("focus" in element)) return false;
  (element as HTMLElement).focus();
  return (element.getRootNode() as Document | ShadowRoot).activeElement === element;
}

export async function formSubmitNames(
  page: PageHandle,
  epoch: number,
  ref: string,
): Promise<string[]> {
  if (ref.startsWith("frame:")) {
    const separator = ref.indexOf("/");
    const marker = ref.lastIndexOf("@", separator);
    const frame = (await page.frames()).find((item) => item.id === ref.slice(6, marker));
    if (!frame) return [];
    return frame.callIsolated(formSubmitNamesInPage, [
      Number(ref.slice(marker + 1, separator)),
      ref.slice(separator + 1),
    ]);
  }
  return page.callIsolated(formSubmitNamesInPage, [epoch, ref]);
}

export function formSubmitNamesInPage(epoch: number, ref: string): string[] {
  const global = globalThis as typeof globalThis & {
    __jevpilotObserverLibrary?: ObserverPageLibrary;
    __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
  };
  const registry = global.__jevpilotObserverRegistry;
  if (registry?.epoch !== epoch) return [];
  const element = registry.refs.get(ref)?.deref();
  const form = (element as HTMLInputElement | undefined)?.form;
  const library = global.__jevpilotObserverLibrary;
  if (!element?.isConnected || !form || !library) return [];
  return [...form.elements]
    .filter((control) => {
      const type = (control as HTMLInputElement).type;
      return (
        (control.localName === "button" && (!type || type === "submit")) ||
        (control.localName === "input" && ["submit", "image"].includes(type))
      );
    })
    .map((control) => library.nameOf(control));
}

export function resolveRefInPage(
  epoch: number,
  ref: string,
  fingerprint: string,
  precheck?: boolean,
  strict?: boolean,
): RefResolution;
export function resolveRefInPage(
  epoch: number,
  ref: string,
  fingerprint: string,
  precheck = false,
  strict = false,
  waitKind?: "click" | "toggle" | "select" | "type" | "submit",
  timeoutMs = 2000,
  fastCoveredSubmit = false,
): RefResolution | Promise<RefResolution> {
  if (waitKind) {
    return (async () => {
      const started = performance.now();
      const state = globalThis as typeof globalThis & {
        __jevpilotObserverRegistry?: { epoch: number; refs: Map<string, WeakRef<Element>> };
        __jevpilotObserverLibrary?: ObserverPageLibrary;
      };
      let lastBox = "";
      let unchangedFrames = 0;
      let scrolled = false;
      let timerMode = false;
      let firstCheck = true;
      const deadline = started + timeoutMs;
      for (;;) {
        const result = resolveRefInPage(epoch, ref, fingerprint, true, strict) as RefResolution;
        if (result.status !== "ok") return { ...result, waitMs: 0 };
        const element = state.__jevpilotObserverRegistry?.refs.get(ref)?.deref();
        if (!element) return { status: "missing", waitMs: 0 };
        const library = state.__jevpilotObserverLibrary!;
        const box = element.getBoundingClientRect();
        if (
          !scrolled &&
          (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
        ) {
          element.scrollIntoView({ block: "center", inline: "center" });
          scrolled = true;
        }
        let unmet: RefResolution["unmet"];
        if (!result.visible) unmet = "invisible";
        else if (!result.enabled) unmet = "disabled";
        else if (
          box.right <= 0 ||
          box.bottom <= 0 ||
          box.left >= innerWidth ||
          box.top >= innerHeight
        )
          unmet = "invisible";
        else if (
          waitKind === "type" &&
          ((element as HTMLInputElement).readOnly ||
            element.getAttribute("aria-readonly") === "true")
        )
          unmet = "not-editable";
        else {
          const active = new Set<Element>();
          for (
            let ancestor: Element | null = element;
            ancestor;
            ancestor = library.composedParent(ancestor)
          )
            active.add(ancestor);
          const animations = document.getAnimations().filter((animation) => {
            const target = (animation.effect as KeyframeEffect | null)?.target;
            return (
              animation.playState === "running" && target instanceof Element && active.has(target)
            );
          });
          // A just-created transition stays pending (not moving yet) for a few frames; frames
          // before it starts say nothing about stability, so they do not count as unchanged.
          const pending = animations.some((animation) => animation.pending);
          const boxKey = `${box.x},${box.y},${box.width},${box.height}`;
          unchangedFrames = boxKey === lastBox && !pending ? unchangedFrames + 1 : 0;
          lastBox = boxKey;
          if (animations.length && (pending || unchangedFrames < 2)) unmet = "unstable";
          else if (result.coveredBy) unmet = "covered";
        }
        let focusPath = false;
        if (unmet === "covered" && (waitKind === "type" || waitKind === "submit")) {
          const role = library.roleOf(element).role;
          if (
            ["input", "textarea"].includes(element.localName) ||
            ["searchbox", "combobox", "textbox"].includes(role)
          ) {
            const point = result.clickPoint!;
            let cover = element.ownerDocument.elementFromPoint(point.x, point.y);
            while (cover?.shadowRoot?.elementFromPoint(point.x, point.y))
              cover = cover.shadowRoot.elementFromPoint(point.x, point.y);
            const interactive =
              '[role="button"], [role="link"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="listbox"], [role="menu"], [role="tooltip"], [role="combobox"], a, button, select, input, textarea';
            if (cover && !library.composedClosest(cover, interactive)) {
              focusPath = true;
              unmet = undefined;
            }
          }
        }
        if (!unmet) {
          const { coveredBy: _cover, ...ready } = result;
          return {
            ...ready,
            focusPath,
            waitMs: firstCheck ? 0 : Math.max(0, performance.now() - started),
          };
        }
        if (
          unmet === "covered" &&
          result.coveredBy &&
          (["listbox", "menu", "tooltip", "combobox"].includes(result.coveredBy.role) ||
            (fastCoveredSubmit &&
              ["div", "span", "p", "section", "ul", "li"].includes(result.coveredBy.role)))
        )
          return { ...result, unmet, waitMs: 0 };
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          return { ...result, unmet, waitMs: Math.max(0, performance.now() - started) };
        firstCheck = false;
        await new Promise<void>((resolve) => {
          if (timerMode) {
            setTimeout(resolve, Math.min(16, remaining));
            return;
          }
          let done = false;
          const finish = (fallback: boolean): void => {
            if (done) return;
            done = true;
            if (fallback) timerMode = true;
            resolve();
          };
          const frame = requestAnimationFrame(() => {
            clearTimeout(fallback);
            finish(false);
          });
          const fallback = setTimeout(
            () => {
              cancelAnimationFrame(frame);
              finish(true);
            },
            Math.min(50, remaining),
          );
        });
      }
    })();
  }
  const global = globalThis as typeof globalThis & {
    __jevpilotObserverLibrary?: ObserverPageLibrary;
    __jevpilotObserverRegistry?: {
      epoch: number;
      refs: Map<string, WeakRef<Element>>;
      locations: Map<string, { framePath: string; offsetX: number; offsetY: number }>;
      identities?: Map<string, { role: string; name: string; formId: string; fingerprint: string }>;
    };
  };
  const registry = global.__jevpilotObserverRegistry;
  if (!registry || registry.epoch !== epoch) return { status: "stale-epoch" };
  const library = global.__jevpilotObserverLibrary;
  if (!library) return { status: "missing" };
  const element = registry.refs.get(ref)?.deref();
  if (!element || !element.isConnected) return { status: "missing" };
  const location = registry.locations.get(ref);
  const role = library.roleOf(element).role;
  const name = library.nameOf(element);
  const formId = library.formOf(element, location?.framePath ?? "") ?? "";
  const storedIdentity = registry.identities?.get(ref);
  void fingerprint;
  if (!storedIdentity) return { status: "identity-changed" };
  const comparison = library.compareIdentity(
    { role: storedIdentity.role, name: storedIdentity.name, formId: storedIdentity.formId },
    { role, name, formId },
    strict,
  );
  if (comparison === "changed") return { status: "identity-changed" };
  const drift = comparison === "drift";
  if (precheck) {
    const initial = element.getBoundingClientRect();
    if (
      initial.top < 0 ||
      initial.left < 0 ||
      initial.bottom > innerHeight ||
      initial.right > innerWidth
    )
      element.scrollIntoView({ block: "center", inline: "center" });
  }
  const box = element.getBoundingClientRect();
  const clientRects = [...(element.getClientRects?.() ?? [box])].filter(
    (client) => client.width > 0 && client.height > 0,
  );
  const inlineLink = role === "link" && getComputedStyle(element).display === "inline";
  const clickBox = inlineLink
    ? (clientRects[0] ?? box)
    : (clientRects.sort(
        (left, right) => right.width * right.height - left.width * left.height,
      )[0] ?? box);
  const clickRect = {
    x: clickBox.x + (location?.offsetX ?? 0),
    y: clickBox.y + (location?.offsetY ?? 0),
    width: clickBox.width,
    height: clickBox.height,
  };
  const style = getComputedStyle(element);
  const centreX = precheck
    ? Math.max(0, Math.min(innerWidth - 1, clickRect.x + clickRect.width / 2))
    : 0;
  const centreY = precheck
    ? Math.max(0, Math.min(innerHeight - 1, clickRect.y + clickRect.height / 2))
    : 0;
  const jitter = (size: number): number => (Math.random() * 2 - 1) * Math.min(3, size * 0.1);
  const point = precheck
    ? {
        x: Math.max(
          clickRect.x,
          Math.min(clickRect.x + clickRect.width, centreX + jitter(clickRect.width)),
        ),
        y: Math.max(
          clickRect.y,
          Math.min(clickRect.y + clickRect.height, centreY + jitter(clickRect.height)),
        ),
      }
    : undefined;
  let hit = point ? element.ownerDocument.elementFromPoint(point.x, point.y) : null;
  while (hit?.shadowRoot && point) hit = hit.shadowRoot.elementFromPoint(point.x, point.y);
  let targetHit = false;
  for (let current = hit; current; current = library.composedParent(current)) {
    if (current === element) {
      targetHit = true;
      break;
    }
  }
  const covering = hit && !targetHit ? hit : null;
  const coverIdentity = covering
    ? (library.composedClosest(
        covering,
        '[role="listbox"], [role="menu"], [role="tooltip"], [role="combobox"]',
      ) ?? covering)
    : null;
  const control = element as HTMLInputElement;
  const autocomplete = element.getAttribute("autocomplete")?.toLowerCase() ?? "";
  const secret =
    element.localName === "input" &&
    (control.type === "password" ||
      /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[^\s]+)(?=\s|$)/u.test(
        autocomplete,
      ) ||
      /pass(?:word)?|pwd|otp|cvv|cvc/iu.test(
        `${element.getAttribute("name") ?? ""} ${element.id}`,
      ));
  let valueChanged: boolean | undefined;
  if (secret) {
    let valueHash = 2166136261;
    for (const character of control.value) {
      valueHash ^= character.charCodeAt(0);
      valueHash = Math.imul(valueHash, 16777619);
    }
    const secretState = global as typeof global & {
      __jevpilotSecretBaselines?: Map<string, number>;
    };
    if (precheck) {
      secretState.__jevpilotSecretBaselines ??= new Map();
      secretState.__jevpilotSecretBaselines.set(ref, valueHash >>> 0);
    } else {
      const baseline = secretState.__jevpilotSecretBaselines?.get(ref);
      if (baseline !== undefined) valueChanged = baseline !== valueHash >>> 0;
      secretState.__jevpilotSecretBaselines?.delete(ref);
    }
  }
  if (precheck) {
    const state = global as typeof global & {
      __jevpilotMutationState?: { count: number; observer: MutationObserver };
    };
    state.__jevpilotMutationState?.observer.disconnect();
    const mutationState = {
      count: 0,
      observer: new MutationObserver(() => {
        mutationState.count++;
      }),
    };
    mutationState.observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    state.__jevpilotMutationState = mutationState;
  }
  return {
    status: "ok",
    ...(drift ? { drift: true } : {}),
    rect: clickRect,
    ...(point ? { clickPoint: point } : {}),
    visible:
      box.width > 0 &&
      box.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      !element.closest('[aria-hidden="true"], [inert]'),
    enabled:
      !(element as HTMLInputElement).disabled && element.getAttribute("aria-disabled") !== "true",
    ...(covering
      ? {
          coveredBy: {
            role: coverIdentity!.getAttribute("role") || coverIdentity!.localName,
            name: library.clean(
              coverIdentity!.getAttribute("aria-label") || coverIdentity!.textContent,
            ),
          },
        }
      : {}),
    ...(secret
      ? { ...(valueChanged === undefined ? {} : { valueChanged }) }
      : {
          value:
            (element as HTMLElement).isContentEditable &&
            (element.getAttribute("role") === "textbox" || element.hasAttribute("contenteditable"))
              ? library.clean((element as HTMLElement).innerText, 60)
              : (control.value ?? ""),
        }),
    checked: control.checked ?? false,
    ...(element.localName === "select"
      ? {
          selectedIndex: (element as HTMLSelectElement).selectedIndex,
          selectedLabel: (element as HTMLSelectElement).selectedOptions[0]?.label ?? "",
          optionLabels: [...(element as HTMLSelectElement).options].map((option) => option.label),
          optionDisabled: [...(element as HTMLSelectElement).options].map(
            (option) => option.disabled,
          ),
          selectPopup:
            !(element as HTMLSelectElement).multiple && (element as HTMLSelectElement).size <= 1,
        }
      : {}),
  };
}
