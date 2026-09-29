import { FrameGoneError, type PageHandle } from "../engine/types.ts";

export type PageAssertions = {
  text_present?: string;
  element_present?: { role: string; name: string };
};

export function matchesInPage(
  assertions: PageAssertions,
  pendingEchoTexts: string[] = [],
): boolean {
  const roots: (Document | ShadowRoot)[] = [document];
  const candidates: Element[] = [];
  const text: string[] = [];
  const visible = (element: Element, requireSize = true): boolean => {
    if (typeof element.getBoundingClientRect !== "function") return true;
    if (!element.isConnected) return false;
    for (let current: Element | null = element; current;) {
      if (current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true")
        return false;
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      )
        return false;
      const parent: Element | null = current.parentElement;
      const root = current.getRootNode();
      current = parent ?? (root instanceof ShadowRoot ? root.host : null);
    }
    if (!requireSize) return true;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index]!;
    if (root instanceof Document) text.push(root.body?.innerText ?? "");
    else {
      const parts: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement ?? root.host;
        if (!visible(parent, false) || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if ([...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0))
          parts.push(node.textContent ?? "");
      }
      text.push(parts.join(" "));
    }
    for (const element of root.querySelectorAll("*")) {
      candidates.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
      if (element instanceof HTMLIFrameElement) {
        try {
          if (element.contentDocument) roots.push(element.contentDocument);
        } catch {
          /* Cross-origin frames are inaccessible. */
        }
      }
    }
  }
  if (assertions.text_present) {
    if (!text.some((part) => part.includes(assertions.text_present!))) return false;
    const cleanText = (value: string): string => value.trim().replace(/\s+/gu, " ").toLowerCase();
    const asserted = cleanText(assertions.text_present);
    const echoed = pendingEchoTexts.some((value) => {
      const typed = cleanText(value);
      if (typed.length < 2 || !typed || !(asserted.includes(typed) || typed.includes(asserted)))
        return false;
      return candidates.some((element) => {
        const tag = element.tagName.toLowerCase();
        const content =
          tag === "input" || tag === "textarea"
            ? (element as HTMLInputElement | HTMLTextAreaElement).value
            : (element as HTMLElement).isContentEditable
              ? (element.textContent ?? "")
              : "";
        return cleanText(content).includes(typed);
      });
    });
    if (echoed) return false;
  }
  if (!assertions.element_present) return true;
  const { role, name } = assertions.element_present;
  const clean = (value: string | null | undefined): string =>
    (value ?? "").trim().replace(/\s+/gu, " ");
  return candidates.some((element) => {
    const tag = element.tagName.toLowerCase();
    const inputType = tag === "input" ? (element as HTMLInputElement).type.toLowerCase() : "";
    const implicit =
      tag === "input"
        ? inputType === "checkbox" || inputType === "radio"
          ? inputType
          : ["button", "submit", "reset", "image"].includes(inputType)
            ? "button"
            : "input"
        : tag === "button" || tag === "summary"
          ? "button"
          : tag === "a" && element.hasAttribute("href")
            ? "link"
            : tag === "select"
              ? "select"
              : tag === "textarea"
                ? "textarea"
                : element.hasAttribute("contenteditable") &&
                    element.getAttribute("contenteditable") !== "false"
                  ? "textbox"
                  : "";
    if ((element.getAttribute("role") ?? implicit) !== role) return false;
    const labelledBy = element
      .getAttribute("aria-labelledby")
      ?.split(/\s+/u)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    const labels = "labels" in element ? (element as HTMLInputElement).labels : null;
    const label = labels?.length
      ? [...labels].map((item) => item.textContent ?? "").join(" ")
      : element.closest("label")?.textContent;
    const accessibleName =
      clean(labelledBy) ||
      clean(element.getAttribute("aria-label")) ||
      clean(label) ||
      clean(element.getAttribute("placeholder")) ||
      clean(element.getAttribute("alt")) ||
      clean(element.textContent) ||
      clean(element.getAttribute("title"));
    // Visibility walks the ancestors' computed styles, so it runs only for a role and name match.
    return accessibleName === name && visible(element);
  });
}

export async function pageMatches(
  page: PageHandle,
  assertions: PageAssertions,
  pendingEchoTexts: string[] = [],
): Promise<boolean> {
  // Child frames are listed only when the main frame does not satisfy an assertion.
  let frames: Awaited<ReturnType<PageHandle["frames"]>> | undefined;
  for (const assertion of [
    ...(assertions.text_present ? [{ text_present: assertions.text_present }] : []),
    ...(assertions.element_present ? [{ element_present: assertions.element_present }] : []),
  ]) {
    if (await page.callIsolated(matchesInPage, [assertion, pendingEchoTexts])) continue;
    let matched = false;
    frames ??= await page.frames();
    for (const frame of frames) {
      try {
        if (await frame.callIsolated(matchesInPage, [assertion, pendingEchoTexts])) {
          matched = true;
          break;
        }
      } catch (error) {
        if (
          !(error instanceof FrameGoneError) &&
          !(error instanceof Error && error.name === "EvaluationError")
        )
          throw error;
      }
    }
    if (!matched) return false;
  }
  return true;
}
