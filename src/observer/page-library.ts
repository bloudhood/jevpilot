export type ObserverPageLibrary = {
  clean(value: string | null | undefined, limit?: number): string;
  rectOf(
    element: Element,
    offsetX?: number,
    offsetY?: number,
  ): { x: number; y: number; width: number; height: number };
  visible(element: Element, rect: { x: number; y: number; width: number; height: number }): boolean;
  markerVisible(
    element: Element,
    rect: { x: number; y: number; width: number; height: number },
  ): boolean;
  composedText(root: Node, limit: number, skip?: (node: Text) => boolean): string;
  composedElements(root: Node): Element[];
  composedParent(element: Element): Element | null;
  composedClosest(element: Element, selector: string): Element | null;
  textFromNodes(element: Element): string;
  roleOf(element: Element): { role: string; type?: string };
  nameOf(element: Element): string;
  iconHint(element: Element): string | undefined;
  compareIdentity(
    expected: { role: string; name: string; formId?: string },
    actual: { role: string; name: string; formId?: string },
    strict?: boolean,
  ): "equal" | "drift" | "changed";
  nearbyNameOf(element: Element): string;
  formOf(element: Element, framePath: string): string | undefined;
  hash(value: string): string;
};

export function installObserverLibrary(): void {
  const global = globalThis as typeof globalThis & {
    __jevpilotObserverLibrary?: ObserverPageLibrary;
  };
  if (global.__jevpilotObserverLibrary) return;
  const clean = (value: string | null | undefined, limit = 80): string =>
    (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const rectOf = (element: Element, offsetX = 0, offsetY = 0) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height };
  };
  const composedParent = (element: Element): Element | null =>
    element.parentElement ??
    (element.getRootNode() instanceof ShadowRoot
      ? (element.getRootNode() as ShadowRoot).host
      : null);
  const visible = (element: Element, rect: { width: number; height: number }): boolean => {
    if (rect.width <= 0 || rect.height <= 0) return false;
    let current: Element | null = element;
    while (current) {
      if (current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert"))
        return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
        return false;
      current = composedParent(current);
    }
    return true;
  };
  const walkComposed = (root: Node, visitNode: (node: Node) => void): void => {
    const visitTree = (node: Node): void => {
      visitNode(node);
      if (node.nodeType === 1 && (node as Element).shadowRoot)
        walkComposed((node as Element).shadowRoot!, visitNode);
      else if (node.nodeType === 1 && (node as Element).localName === "slot") {
        const slot = node as HTMLSlotElement;
        const assigned = slot.assignedNodes();
        for (const item of assigned.length ? assigned : [...node.childNodes]) visitTree(item);
      } else for (const item of node.childNodes ?? []) visitTree(item);
    };
    const container =
      root.nodeType === 1 && (root as Element).shadowRoot ? (root as Element).shadowRoot! : root;
    for (const child of container.childNodes ?? []) visitTree(child);
  };
  const composedText = (root: Node, limit: number, skip?: (node: Text) => boolean): string => {
    const fixtureTextNodes = (root as Node & { textNodes?: string[] }).textNodes;
    if (Array.isArray(fixtureTextNodes)) return clean(fixtureTextNodes.join(" "), limit);
    if (!root.childNodes?.length) return clean(root.textContent, limit);
    const parts: string[] = [];
    walkComposed(root, (node) => {
      if (node.nodeType !== 3 || (skip && skip(node as Text))) return;
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, noscript, svg title")) return;
      if (!visible(parent, rectOf(parent))) return;
      const part = clean(node.textContent, Math.max(0, limit - parts.join(" ").length));
      if (part) parts.push(part);
    });
    return clean(parts.join(" "), limit);
  };
  const composedElements = (root: Node): Element[] => {
    const found: Element[] = [];
    walkComposed(root, (node) => {
      if (node.nodeType === 1) found.push(node as Element);
    });
    return found;
  };
  const composedClosest = (element: Element, selector: string): Element | null => {
    let current: Element | null = element;
    while (current) {
      if (typeof current.matches === "function" && current.matches(selector)) return current;
      current = composedParent(current);
    }
    return null;
  };
  const textFromNodes = (element: Element): string => {
    if (
      !element.childNodes?.length ||
      (element.childNodes.length === 1 && element.firstChild?.nodeType === 3)
    )
      return clean(element.textContent);
    return composedText(element, 80);
  };
  const roles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "option",
    "combobox",
    "textbox",
    "searchbox",
    "slider",
    "spinbutton",
    "listbox",
    "treeitem",
  ]);
  const iconVocabulary: ReadonlyMap<string, string> = new Map([
    ["search", "search"],
    ["sousuo", "search"],
    ["搜索", "search"],
    ["menu", "menu"],
    ["hamburger", "menu"],
    ["nav-toggle", "menu"],
    ["caidan", "menu"],
    ["close", "close"],
    ["dismiss", "close"],
    ["guanbi", "close"],
    ["user", "account"],
    ["login", "account"],
    ["signin", "account"],
    ["account", "account"],
    ["avatar", "account"],
    ["denglu", "account"],
    ["cart", "cart"],
    ["basket", "cart"],
    ["gouwuche", "cart"],
    ["share", "share"],
    ["fenxiang", "share"],
    ["more", "more"],
    ["ellipsis", "more"],
    ["gengduo", "more"],
    ["next", "next"],
    ["xiayiye", "next"],
    ["prev", "previous"],
    ["previous", "previous"],
    ["shangyiye", "previous"],
    ["play", "play"],
    ["download", "download"],
    ["xiazai", "download"],
    ["filter", "filter"],
    ["shaixuan", "filter"],
    ["setting", "settings"],
    ["settings", "settings"],
    ["gear", "settings"],
    ["shezhi", "settings"],
    ["home", "home"],
    ["shouye", "home"],
    ["favorite", "favorite"],
    ["heart", "favorite"],
    ["star", "favorite"],
    ["shoucang", "favorite"],
    ["bell", "notifications"],
    ["notification", "notifications"],
    ["xiaoxi", "notifications"],
  ]);
  const iconHint = (element: Element): string | undefined => {
    const split = (value: string): string[] =>
      value
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .split(/[^a-z0-9\u3400-\u9fff]+/giu)
        .map((token) => token.toLowerCase())
        .filter(Boolean);
    let node: Element | null = element;
    for (let visited = 0; node && visited < 20; visited++) {
      const values = [
        node.getAttribute("class") ?? "",
        node.id,
        node.getAttribute("data-icon") ?? "",
      ];
      if (node.localName === "use") {
        for (const reference of [node.getAttribute("href"), node.getAttribute("xlink:href")]) {
          if (reference?.includes("#"))
            values.push(reference.slice(reference.lastIndexOf("#") + 1));
        }
      }
      if (node.localName === "img") {
        values.push(node.getAttribute("alt") ?? "");
        const src = node.getAttribute("src") ?? "";
        values.push(src.slice(src.lastIndexOf("/") + 1).split(/[?#]/u)[0] ?? "");
      }
      for (const value of values) {
        const tokens = split(value);
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index]!;
          if (token === "nav" && tokens[index + 1] === "toggle") return "menu";
          const hint = iconVocabulary.get(token);
          if (hint) return hint;
        }
      }
      if (node.firstElementChild) {
        node = node.firstElementChild;
      } else {
        while (node && node !== element && !node.nextElementSibling) node = node.parentElement;
        node = node === element ? null : (node?.nextElementSibling ?? null);
      }
    }
    return undefined;
  };
  const roleOf = (element: Element): { role: string; type?: string } => {
    if (
      element.localName === "input" &&
      (element as HTMLInputElement).type.toLowerCase() === "hidden"
    )
      return { role: "hidden", type: "hidden" };
    const explicit = element.getAttribute("role")?.toLowerCase();
    if (explicit && roles.has(explicit))
      return element.localName === "input"
        ? { role: explicit, type: (element as HTMLInputElement).type.toLowerCase() }
        : { role: explicit };
    const tag = element.localName;
    if (tag === "input") {
      const type = (element as HTMLInputElement).type.toLowerCase();
      if (type === "hidden") return { role: "hidden", type };
      if (["checkbox", "radio"].includes(type)) return { role: type, type };
      if (["button", "submit", "reset", "image"].includes(type)) return { role: "button", type };
      return { role: "input", type };
    }
    if (tag === "a" && element.hasAttribute("href")) return { role: "link" };
    if (tag === "button" || tag === "summary")
      return {
        role: "button",
        ...(tag === "button"
          ? { type: element.getAttribute("type")?.toLowerCase() ?? "submit" }
          : {}),
      };
    if (tag === "select") return { role: "select" };
    if (tag === "textarea") return { role: "textarea" };
    if (
      element.hasAttribute("contenteditable") &&
      element.getAttribute("contenteditable") !== "false"
    )
      return { role: "textbox" };
    const style = getComputedStyle(element);
    if (
      style.cursor === "pointer" &&
      (element.hasAttribute("onclick") || (element as HTMLElement).tabIndex >= 0)
    )
      return { role: "clickable" };
    if (
      style.cursor === "pointer" &&
      getComputedStyle(composedParent(element) ?? document.documentElement ?? element).cursor !==
        "pointer"
    ) {
      const rect = rectOf(element);
      const interactive =
        "a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable]:not([contenteditable=false]), [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=textbox], [role=searchbox], [role=combobox], [role=slider], [role=spinbutton], [role=listbox], [role=treeitem]";
      if (
        rect.width >= 16 &&
        rect.height >= 16 &&
        visible(element, rect) &&
        (nameOf(element) || iconHint(element)) &&
        !composedClosest(composedParent(element) ?? element, interactive) &&
        !composedElements(element).some(
          (child) =>
            child.matches(interactive) || (child !== element && child.hasAttribute("onclick")),
        )
      )
        return { role: "clickable" };
    }
    return { role: "" };
  };
  const nameOf = (element: Element): string => {
    const visited = new Set<Element>();
    const hidden = (target: Element): boolean => {
      if (target === element) return false;
      const style = getComputedStyle(target);
      return (
        target.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden"
      );
    };
    const text = (target: Element, fromReference = false): string => {
      if (visited.has(target)) return "";
      if (!fromReference && hidden(target)) return "";
      visited.add(target);
      const labelledBy = target.getAttribute("aria-labelledby");
      if (labelledBy && !fromReference) {
        const value = clean(
          labelledBy
            .split(/\s+/u)
            .map((id) => {
              const ref = target.ownerDocument.getElementById(id);
              return ref ? text(ref, true) : "";
            })
            .join(" "),
        );
        if (value) return value;
      }
      const aria = clean(target.getAttribute("aria-label"));
      if (aria) return aria;
      if (target.localName === "img" || target.localName === "area") {
        const alt = clean(target.getAttribute("alt"));
        if (alt) return alt;
      }
      const role = target.getAttribute("role")?.toLowerCase() ?? "";
      const title = clean(target.getAttribute("title"));
      if (fromReference && ["input", "select", "textarea"].includes(target.localName)) {
        if (target === element) return "";
        const control = target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (target.localName === "select")
          return clean((control as HTMLSelectElement).selectedOptions[0]?.label);
        return clean(control.value);
      }
      if (target.localName === "input" && !fromReference) {
        const input = target as HTMLInputElement;
        const type = input.type.toLowerCase();
        if (type === "image")
          return clean(input.getAttribute("alt")) || clean(input.value) || title;
        if (["submit", "reset", "button"].includes(type)) {
          const value = input.getAttribute("value");
          if (value) return clean(value);
          if (type === "submit") return "Submit";
          if (type === "reset") return "Reset";
        }
      }
      const formControl =
        ["input", "select", "textarea"].includes(target.localName) ||
        ["combobox", "textbox", "searchbox"].includes(role);
      if (formControl && !fromReference) {
        const labels = (target as HTMLInputElement).labels;
        const labelText = labels
          ? clean([...labels].map((label) => text(label, true)).join(" "))
          : "";
        if (labelText) return labelText;
        if (title) return title;
        const placeholder = clean(target.getAttribute("placeholder"));
        if (placeholder) return placeholder;
        return "";
      }
      const root = target.shadowRoot ?? target;
      const children = [...(root.childNodes ?? [])];
      const content = clean(
        [
          getComputedStyle(target, "::before").content?.replace(/^(["'])(.*)\1$/u, "$2"),
          ...(children.length ? [] : [root.textContent ?? ""]),
          ...children.flatMap((node) => {
            if (node.nodeType === 3) return [clean(node.textContent)];
            if (node.nodeType !== 1) return [];
            const child = node as Element;
            if (child.localName === "slot") {
              const assigned = (child as HTMLSlotElement).assignedNodes();
              const slotted = assigned.length ? assigned : [...child.childNodes];
              return slotted.map((item) =>
                item.nodeType === 3
                  ? clean(item.textContent)
                  : item.nodeType === 1
                    ? text(item as Element, fromReference)
                    : "",
              );
            }
            return [text(child, fromReference)];
          }),
          getComputedStyle(target, "::after").content?.replace(/^(["'])(.*)\1$/u, "$2"),
        ]
          .filter((part) => part && part !== "none" && part !== "normal")
          .join(" "),
      );
      if (content) return content;
      return title;
    };
    return clean(text(element));
  };
  const formOf = (element: Element, framePath: string): string | undefined => {
    const form = (element as HTMLInputElement).form ?? element.closest("form");
    if (form)
      return `${framePath}form:${form.id || [...form.ownerDocument.forms].indexOf(form as HTMLFormElement)}`;
    if (
      ["input", "select", "textarea"].includes(element.localName) ||
      element.getAttribute("role") === "textbox"
    )
      return `${framePath}implicit`;
    return undefined;
  };
  const nearbyNameOf = (element: Element): string => {
    if (!["input", "select", "textarea"].includes(element.localName)) return "";
    for (const nearby of [element.previousElementSibling, element.parentElement]) {
      if (nearby && visible(nearby, rectOf(nearby))) {
        const value = textFromNodes(nearby);
        if (value) return value;
      }
    }
    return "";
  };
  const hash = (value: string): string => {
    let code = 2166136261;
    for (let index = 0; index < value.length; index++) {
      code ^= value.charCodeAt(index);
      code = Math.imul(code, 16777619);
    }
    return (code >>> 0).toString(36);
  };
  const compareIdentity = (
    expected: { role: string; name: string; formId?: string },
    actual: { role: string; name: string; formId?: string },
    strict = false,
  ): "equal" | "drift" | "changed" => {
    if (expected.role !== actual.role || (expected.formId ?? "") !== (actual.formId ?? ""))
      return "changed";
    if (expected.name === actual.name) return "equal";
    if (!strict && expected.name.replace(/\d+/gu, "#") === actual.name.replace(/\d+/gu, "#"))
      return "drift";
    return "changed";
  };
  const markerVisible = (
    element: Element,
    rect: { x: number; y: number; width: number; height: number },
  ): boolean =>
    visible(element, rect) &&
    rect.x < innerWidth &&
    rect.y < innerHeight &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0;
  global.__jevpilotObserverLibrary = Object.freeze({
    clean,
    rectOf,
    visible,
    markerVisible,
    composedText,
    composedElements,
    composedParent,
    composedClosest,
    textFromNodes,
    roleOf,
    nameOf,
    iconHint,
    compareIdentity,
    nearbyNameOf,
    formOf,
    hash,
  });
}
