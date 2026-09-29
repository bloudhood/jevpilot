import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { waitForNavigationQuiet } from "../../src/observer/page-snapshot.ts";

function fakeClock() {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const observers: {
    notify: (records?: MutationRecord[]) => void;
    active: boolean;
    options?: MutationObserverInit;
  }[] = [];
  const document = { querySelectorAll: () => [] };
  class FakeMutationObserver {
    private readonly state: (typeof observers)[number];
    constructor(notify: (records?: MutationRecord[]) => void) {
      this.state = { notify, active: true };
      observers.push(this.state);
    }
    observe(_target: Node, options: MutationObserverInit) {
      this.state.options = options;
    }
    disconnect() {
      this.state.active = false;
    }
  }
  const wait = runInNewContext(`(${waitForNavigationQuiet.toString()})`, {
    document,
    location: { href: "https://example.test/page" },
    performance: { now: () => now },
    MutationObserver: FakeMutationObserver,
    WeakSet,
    setTimeout: (run: () => void, delay: number) => {
      timers.push({ at: now + delay, run });
    },
  }) as typeof waitForNavigationQuiet;
  const advance = (target: number): void => {
    while (true) {
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = next.at;
      next.run();
    }
    now = target;
  };
  const mutate = (kind: "childList" | "attributes"): void => {
    for (const observer of observers) {
      if (observer.active && observer.options?.[kind]) observer.notify([]);
    }
  };
  const addSubtree = (node: Node): void => {
    for (const observer of observers)
      if (observer.active && observer.options?.childList)
        observer.notify([{ addedNodes: [node] } as unknown as MutationRecord]);
  };
  const scheduleMutation = (at: number, kind: "childList" | "attributes" = "childList"): void => {
    timers.push({ at, run: () => mutate(kind) });
  };
  return { wait, advance, scheduleMutation, addSubtree, observers };
}

test("navigation quiet wait uses the short probe and child-list quiet period", async () => {
  const staticPage = fakeClock();
  const staticWait = staticPage.wait();
  staticPage.advance(50);
  assert.equal(await staticWait, 50);

  const attributeOnlyPage = fakeClock();
  const attributeWait = attributeOnlyPage.wait();
  for (let at = 10; at <= 1000; at += 10) attributeOnlyPage.scheduleMutation(at, "attributes");
  attributeOnlyPage.advance(50);
  assert.equal(await attributeWait, 50);

  const mutatingPage = fakeClock();
  const mutatingWait = mutatingPage.wait();
  mutatingPage.scheduleMutation(50);
  mutatingPage.scheduleMutation(100);
  mutatingPage.advance(300);
  assert.equal(await mutatingWait, 300);

  const cappedPage = fakeClock();
  const cappedWait = cappedPage.wait();
  for (let at = 50; at <= 1500; at += 50) cappedPage.scheduleMutation(at);
  cappedPage.advance(1500);
  assert.equal(await cappedWait, 1500);
  assert.ok(cappedPage.observers.every((observer) => !observer.active));

  const dynamicPage = fakeClock();
  const dynamicWait = dynamicPage.wait();
  const shadowRoot = { querySelectorAll: () => [] };
  const host = { nodeType: 1, shadowRoot, querySelectorAll: () => [] } as unknown as Node;
  dynamicPage.addSubtree(host);
  assert.equal(dynamicPage.observers.length, 2);
  dynamicPage.advance(200);
  assert.equal(await dynamicWait, 200);
});
