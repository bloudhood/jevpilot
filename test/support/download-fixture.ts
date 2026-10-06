import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult } from "../../src/executor/types.ts";
import type { PageEvents } from "../../src/engine/types.ts";
import {
  OrchestratorSession,
  type SessionDeps,
  type SessionOptions,
} from "../../src/orchestrator/session.ts";
import type { Observation } from "../../src/observer/types.ts";
import { FakePageHandle } from "./fake-engine.ts";

export function downloadObservation(): Observation {
  return {
    url: "http://downloads.test/",
    title: "Downloads",
    readyState: "complete",
    epoch: 1,
    viewport: { width: 800, height: 600 },
    scroll: { x: 0, y: 0, maxY: 0 },
    elements: [],
    text: "download page",
    headings: [],
    forms: [],
    signals: {
      passwordFieldVisible: false,
      modalOverlay: false,
      dialogOpen: false,
      iframeOrigins: [],
      scriptOrigins: [],
    },
    pageHash: "downloads",
    timings: { snapshotMs: 0, totalMs: 0 },
  };
}

export async function downloadRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jevpilot-download-test-"));
}

export function downloadSession(options: Partial<SessionOptions> & { downloadPath: string }) {
  const page = new FakePageHandle();
  const deps: Partial<SessionDeps> = {
    observe: async () => downloadObservation(),
    detect: () => [],
    buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
    decide: async () => ({
      answers: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      provider: "test",
      model: "test",
      latencyMs: 0,
      attempts: 1,
    }),
    interpret: () => ({ type: "done_candidate", goalMet: 0 }),
    pageMatches: async () => false,
    executeAction: async (): Promise<ActionResult> => ({
      outcome: "unchanged",
      changes: { url: false, pageHash: false, value: false, checked: false },
      timings: { precheckMs: 0, inputMs: 0, settleMs: 0, harnessMs: 0 },
    }),
    now: () => Date.now(),
    sleep: async () => {},
  };
  const session = new OrchestratorSession({ page, goal: "download", ...options }, deps);
  return { page, session };
}

export function downloadEvent(
  id: string,
  suggestedFilename: string,
  state: PageEvents["download"]["state"],
  path?: string,
): PageEvents["download"] {
  return {
    id,
    url: "https://signed.example/download",
    suggestedFilename,
    state,
    ...(path ? { path } : {}),
  };
}

export function downloadStates(result: {
  downloads?: Array<{ state: string }> | undefined;
}): string[] {
  return (result.downloads ?? []).map((entry) => entry.state);
}
