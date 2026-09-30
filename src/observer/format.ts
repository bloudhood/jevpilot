import { estimateTokens } from "../decision/limits.ts";
import type { Observation, ObservedElement } from "./types.ts";

// A link target that is not a web address is shown as the page wrote it; a line break in it must not
// start a line of its own in the observation.
const oneLine = (value: string): string => value.replace(/[\p{C}\p{Z}\s]+/gu, " ");

export function shortenHref(href: string, pageUrl: string): string {
  try {
    const page = new URL(pageUrl);
    const target = new URL(href, page);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      const flat = oneLine(href);
      return flat.slice(0, 59) + (flat.length > 60 ? "…" : "");
    }
    if (
      target.origin === page.origin &&
      target.pathname === page.pathname &&
      target.search === page.search &&
      target.hash
    )
      return target.hash.length > 60 ? `${target.hash.slice(0, 59)}…` : target.hash;
    const query = target.search.length > 40 ? "?…" : target.search;
    const display = `${target.origin === page.origin ? "" : target.host}${target.pathname}${query}${target.hash}`;
    return display.length > 60 ? `${display.slice(0, 59)}…` : display;
  } catch {
    const flat = oneLine(href);
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
  }
}

function elementLine(element: ObservedElement, pageUrl: string): string {
  const role = element.role === "input" ? `input[${element.inputType ?? "text"}]` : element.role;
  const parts = [`${element.ref}  ${role}  ${JSON.stringify(element.name)}`];
  if (!element.name && element.iconHint) parts.push(`icon ${element.iconHint}`);
  if (element.required) parts.push("required");
  if (element.disabled) parts.push("disabled");
  if (element.readonly) parts.push("readonly");
  if (element.checked) parts.push("checked");
  if (element.invalid) parts.push("invalid");
  if (element.placeholder && !element.value)
    parts.push(`placeholder ${JSON.stringify(element.placeholder)}`);
  if (element.role === "select") {
    parts.push(`=${element.optionLabel ?? ""}`);
    parts.push(
      `{${(element.options ?? []).join("|")}}${Math.max(0, (element.optionCount ?? 0) - (element.options?.length ?? 0)) ? `+${(element.optionCount ?? 0) - (element.options?.length ?? 0)}` : ""}`,
    );
  } else if (
    element.value !== undefined &&
    ["input", "textarea", "textbox", "combobox"].includes(element.role)
  )
    parts.push(`=${JSON.stringify(element.value)}`);
  if (element.href) parts.push(`->${shortenHref(element.href, pageUrl)}`);
  return parts.join("  ");
}

export function formatObservation(
  observation: Observation,
  options: { maxTokens?: number } = {},
): string {
  const maxTokens = options.maxTokens ?? 3000;
  const lines = [`url: ${observation.url}`, `title: ${observation.title}`];
  let text = observation.text;
  let elements = observation.elements;
  const render = (): string =>
    [
      ...lines,
      ...elements.map((element) => elementLine(element, observation.url)),
      `page: ${text}`,
    ].join("\n");
  while (estimateTokens(render()) > maxTokens && text.length > 0)
    text = text.slice(0, Math.floor(text.length * 0.7));
  while (estimateTokens(render()) > maxTokens && elements.length > 0) {
    const lowest = elements.reduce(
      (selected, element, index) =>
        (element.priority ?? index) >= (elements[selected]?.priority ?? selected)
          ? index
          : selected,
      0,
    );
    elements = elements.filter((_, index) => index !== lowest);
  }
  return render();
}
