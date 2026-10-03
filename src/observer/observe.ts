import type { PageHandle } from "../engine/types.ts";
import { pageSnapshot, waitForNavigationQuiet } from "./page-snapshot.ts";
import { adFrameRules } from "../util/ad-frames.ts";
import { installObserverLibrary } from "./page-library.ts";
import { FrameGoneError, PageUnresponsiveError } from "../engine/types.ts";
import { mapFrameRect } from "./frame-geometry.ts";
import type { MarkerGeometry, Observation, ObservedElement, ObserveOptions } from "./types.ts";
import { truncateText } from "./format.ts";
export { formatObservation, shortenHref } from "./format.ts";

function mapChildGeometry<T extends MarkerGeometry>(
  matches: T[],
  prefix: string,
  offset: { x: number; y: number; scaleX?: number; scaleY?: number },
  viewport: Observation["viewport"],
  parentVisible: boolean,
): T[] {
  return matches.map((match) => {
    const rect = mapFrameRect(match.rect, offset);
    return {
      ...match,
      framePath: `${prefix}${match.framePath}`,
      rect,
      visible:
        parentVisible &&
        match.visible &&
        rect.x < viewport.width &&
        rect.y < viewport.height &&
        rect.x + rect.width > 0 &&
        rect.y + rect.height > 0,
    };
  });
}

export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  for (const match of value.toLowerCase().matchAll(/[a-z0-9]+|[\p{Script=Han}]+/gu)) {
    const word = match[0];
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      for (let index = 0; index < word.length - 1; index++)
        tokens.push(word.slice(index, index + 2));
      if (word.length === 1) tokens.push(word);
    } else tokens.push(word);
  }
  return tokens;
}

export function selectPageText(text: string, goal: string, budget: number): string {
  if (budget <= 0) return "";
  const normalized = text.replace(/[ \t]+/gu, " ").trim();
  if (normalized.length <= budget) return normalized.replace(/\s*\n\s*/gu, " ");
  const prefix = normalized.slice(0, Math.min(400, budget)).trim();
  const terms = [...new Set(tokenize(goal))];
  if (!terms.length || prefix.length >= budget) return truncateText(normalized, prefix.length);
  const sentences = [...normalized.matchAll(/[^.!?。！？\n]+[.!?。！？]?/gu)]
    .map((match) => ({ text: match[0]!.trim(), start: match.index }))
    .filter((sentence) => sentence.text && sentence.start >= prefix.length);
  const documents = sentences.map((sentence) => tokenize(sentence.text));
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) / (documents.length || 1);
  const frequency = new Map<string, number>();
  for (const document of documents)
    for (const term of new Set(document)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const ranked = sentences
    .map((sentence, index) => {
      const document = documents[index]!;
      const counts = new Map<string, number>();
      for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
      const score = terms.reduce((sum, term) => {
        const count = counts.get(term) ?? 0;
        if (!count) return sum;
        const found = frequency.get(term) ?? 0;
        const idf = Math.log(1 + (sentences.length - found + 0.5) / (found + 0.5));
        return (
          sum +
          (idf * count * 2.2) /
            (count + 1.2 * (0.25 + (0.75 * document.length) / (averageLength || 1)))
        );
      }, 0);
      return { ...sentence, score };
    })
    .filter((sentence) => sentence.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: typeof ranked = [];
  let remaining = budget - prefix.length - 1;
  for (const sentence of ranked) {
    if (remaining <= 1) break;
    const length = Math.min(sentence.text.length, remaining - 1);
    if (length <= 0) continue;
    selected.push({ ...sentence, text: truncateText(sentence.text, length) });
    remaining -= length + 1;
  }
  selected.sort((a, b) => a.start - b.start);
  let output = prefix.endsWith("…") ? prefix : `${prefix}…`;
  let previousEnd = prefix.length;
  for (const sentence of selected) {
    const gap = sentence.start > previousEnd && !output.endsWith("…") ? "…" : " ";
    output += gap + sentence.text;
    previousEnd = sentence.start + sentence.text.length;
  }
  if (previousEnd < normalized.length && !output.endsWith("…")) output += "…";
  return truncateText(output, budget);
}

export function rankByGoal(elements: ObservedElement[], goal: string): ObservedElement[] {
  const terms = tokenize(goal);
  if (terms.length === 0) return elements;
  const documents = elements.map((element) =>
    tokenize(
      `${element.name} ${element.role} ${element.href ?? ""} ${element.optionLabel ?? ""} ${element.containerText ?? ""}`,
    ),
  );
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) / (documents.length || 1);
  const frequency = new Map<string, number>();
  for (const document of documents)
    for (const term of new Set(document)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const score = (index: number): number => {
    const document = documents[index] ?? [];
    const counts = new Map<string, number>();
    for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
    let total = 0;
    for (const term of new Set(terms)) {
      const count = counts.get(term) ?? 0;
      if (!count) continue;
      const found = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (elements.length - found + 0.5) / (found + 0.5));
      total +=
        (idf * (count * 2.2)) /
        (count + 1.2 * (0.25 + (0.75 * document.length) / (averageLength || 1)));
    }
    return total;
  };
  return elements
    .map((element, index) => ({ element, index, score: score(index) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ element }) => element);
}

export function isPaginationElement(element: ObservedElement): boolean {
  if (element.pagination) return true;
  if (/\b(?:next|prev)\b/iu.test(element.rel ?? "")) return true;
  if (/(?:next|previous|下一页|上一页)/iu.test(element.ariaLabel ?? "")) return true;
  if (/(?:[?&](?:page|p)=\d+|\/page\/\d+)(?:\b|\/|$)/iu.test(element.href ?? "")) return true;
  if (
    /^(?:next|previous|prev|more|load more|older|newer|更多|加载更多|下一页|上一页|下页|上页|›|»|→|‹|«|←)$/iu.test(
      element.name,
    )
  )
    return true;
  return /^\d+$/u.test(element.name) && element.paginationContainer === true;
}

export function selectElements(
  snapshot: Omit<Observation, "timings">,
  options: ObserveOptions = {},
): ObservedElement[] {
  const limit = Math.min(255, Math.max(0, options.maxElements ?? 120));
  const range = Math.max(0, options.belowFoldScreens ?? 1) * snapshot.viewport.height;
  const activeFields = new Set(
    snapshot.forms.find((form) => form.active)?.fields.map((field) => field.ref) ?? [],
  );
  const candidates = snapshot.elements.filter(
    (element) =>
      element.inViewport ||
      (element.rect.y + element.rect.height >= 0 && element.distanceBelowFold <= range) ||
      isPaginationElement(element) ||
      activeFields.has(element.ref),
  );
  const kept: ObservedElement[] = [];
  const seen = new Set<string>();
  const add = (element: ObservedElement): void => {
    if (!seen.has(element.ref) && kept.length < limit) {
      kept.push(element);
      seen.add(element.ref);
    }
  };
  for (const element of candidates) if (activeFields.has(element.ref)) add(element);
  for (const element of candidates)
    if (element.role === "searchbox" || element.inputType === "search") add(element);
  for (const element of candidates) if (isPaginationElement(element)) add(element);
  for (const element of candidates
    .filter((item) => item.role === "link" && item.landmark)
    .slice(0, 10))
    add(element);
  for (const element of rankByGoal(
    candidates.filter((item) => !seen.has(item.ref)),
    options.goal ?? "",
  ))
    add(element);
  return kept
    .map((element, priority) => ({ ...element, priority }))
    .sort(
      (left, right) =>
        left.framePath.localeCompare(right.framePath) ||
        Number(left.ref.match(/e(\d+)$/u)?.[1] ?? 0) -
          Number(right.ref.match(/e(\d+)$/u)?.[1] ?? 0),
    );
}

export async function observe(
  page: PageHandle,
  options: ObserveOptions = {},
): Promise<Observation> {
  const started = performance.now();
  const settleMs = await page.callIsolated(
    waitForNavigationQuiet,
    [options.settleNavigation === true],
    {
      timeoutMs: 3200,
    },
  );
  const snapshotStarted = performance.now();
  await page.callIsolated(installObserverLibrary, []);
  const snapshot = await page.callIsolated(pageSnapshot, [
    {
      maxTextChars: options.maxTextChars ?? 1500,
      ...(options.goal ? { textScanChars: Math.max(60_000, options.maxTextChars ?? 1500) } : {}),
      belowFoldScreens: options.belowFoldScreens ?? 1,
      traverseFrames: !page.capabilities.crossOriginFrames,
      adFrameRules,
      ...(options.markerSelectors ? { markerSelectors: options.markerSelectors } : {}),
    },
  ]);
  let framesSkipped = 0;
  let framesFailed = 0;
  let framesMs: number | undefined;
  let childFramesMs: number | undefined;
  if (page.capabilities.crossOriginFrames) {
    const budget = Math.max(1, options.frameTimeoutMs ?? 1000);
    const framesStarted = performance.now();
    const frames = await page.frames({ timeoutMs: budget, skipAdFrames: true });
    framesSkipped += frames.framesSkipped ?? 0;
    framesMs = performance.now() - framesStarted;
    const frameHashes: string[] = [];
    const childrenStarted = performance.now();
    const children = await Promise.all(
      frames.map(async (frame) => {
        const deadline = performance.now() + budget;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            (async () => {
              await frame.callIsolated(installObserverLibrary, [], { timeoutMs: budget });
              return frame.callIsolated(
                pageSnapshot,
                [
                  {
                    maxTextChars: options.maxTextChars ?? 1500,
                    belowFoldScreens: options.belowFoldScreens ?? 1,
                    traverseFrames: false,
                    adFrameRules,
                    ...(options.markerSelectors
                      ? { markerSelectors: options.markerSelectors }
                      : {}),
                  },
                ],
                { timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) },
              );
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new FrameGoneError()), budget);
            }),
          ]);
        } catch (error) {
          if (error instanceof FrameGoneError || error instanceof PageUnresponsiveError)
            return undefined;
          if (error instanceof Error && error.name === "EvaluationError")
            return { failed: true } as const;
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    childFramesMs = performance.now() - childrenStarted;
    for (const [index, child] of children.entries()) {
      if (child && "failed" in child) {
        framesFailed++;
        continue;
      }
      if (!child) {
        framesSkipped++;
        continue;
      }
      const frame = frames[index]!;
      frameHashes.push(`${frame.id}:${child.pageHash}`);
      const prefix = `frame:${frame.id}@${child.epoch}/`;
      for (const element of child.elements) {
        const rect = mapFrameRect(element.rect, frame.offset);
        snapshot.elements.push({
          ...element,
          ref: `${prefix}${element.ref}`,
          framePath: `${prefix}${element.framePath}`,
          rect,
          ...(element.clickRect
            ? {
                clickRect: mapFrameRect(element.clickRect, frame.offset),
              }
            : {}),
          inViewport:
            rect.x + rect.width > 0 &&
            rect.x < snapshot.viewport.width &&
            rect.y + rect.height > 0 &&
            rect.y < snapshot.viewport.height,
          distanceBelowFold: Math.max(0, rect.y - snapshot.viewport.height),
          ...(element.formId ? { formId: `${prefix}${element.formId}` } : {}),
        });
      }
      snapshot.forms.push(
        ...child.forms.map((form) => ({
          ...form,
          id: `${prefix}${form.id}`,
          fields: form.fields.map((field) => ({ ...field, ref: `${prefix}${field.ref}` })),
        })),
      );
      snapshot.signals.passwordFieldVisible ||= child.signals.passwordFieldVisible;
      snapshot.signals.dialogOpen ||= child.signals.dialogOpen;
      if (child.signals.markers && snapshot.signals.markers) {
        const parentFrameVisible = snapshot.signals.markers.iframes.some(
          (match) =>
            match.visible &&
            Math.abs(match.rect.x - frame.offset.x) <= 2 &&
            Math.abs(match.rect.y - frame.offset.y) <= 2,
        );
        snapshot.signals.markers.selectorMatches.push(
          ...mapChildGeometry(
            child.signals.markers.selectorMatches,
            prefix,
            frame.offset,
            snapshot.viewport,
            parentFrameVisible,
          ),
        );
        snapshot.signals.markers.iframes.push(
          ...mapChildGeometry(
            child.signals.markers.iframes,
            prefix,
            frame.offset,
            snapshot.viewport,
            parentFrameVisible,
          ),
        );
        snapshot.signals.markers.scripts.push(
          ...child.signals.markers.scripts.map((match) => ({
            ...match,
            framePath: `${prefix}${match.framePath}`,
          })),
        );
        snapshot.signals.markers.scanMs += child.signals.markers.scanMs;
      }
    }
    if (frameHashes.length) snapshot.pageHash += `:${frameHashes.join(":")}`;
    snapshot.elements = snapshot.elements.filter(
      (element) =>
        element.role !== "frame" ||
        !frames.some(
          (frame) =>
            frame.offset.x >= element.rect.x &&
            frame.offset.x <= element.rect.x + element.rect.width &&
            frame.offset.y >= element.rect.y &&
            frame.offset.y <= element.rect.y + element.rect.height,
        ),
    );
  }
  const snapshotMs = performance.now() - snapshotStarted;
  const elements = selectElements(snapshot, options);
  const text = options.goal
    ? selectPageText(snapshot.text, options.goal, options.maxTextChars ?? 1500)
    : snapshot.text;
  return {
    ...snapshot,
    text,
    elements,
    timings: {
      snapshotMs,
      settleMs,
      totalMs: performance.now() - started,
      ...(framesSkipped ? { framesSkipped } : {}),
      ...(framesFailed ? { framesFailed } : {}),
      ...(framesMs === undefined ? {} : { framesMs }),
      ...(childFramesMs === undefined ? {} : { childFramesMs }),
    },
  };
}
