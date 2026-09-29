import type { PageHandle } from "../engine/types.ts";

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
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index]!;
    text.push(root instanceof Document ? (root.body?.innerText ?? "") : (root.textContent ?? ""));
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
    return accessibleName === name;
  });
}

export async function pageMatches(
  page: PageHandle,
  assertions: PageAssertions,
  pendingEchoTexts: string[] = [],
): Promise<boolean> {
  return page.callIsolated(matchesInPage, [assertions, pendingEchoTexts]);
}
