import { MockDecider } from "../../src/decision/mock.ts";
import type { DecisionRequest, Answers } from "../../src/decision/types.ts";
import { EngineRegistry } from "../../src/engine/registry.ts";
import type { BrowserHandle, EngineDriver } from "../../src/engine/types.ts";
import type { Observation } from "../../src/observer/types.ts";
import type { McpDeps } from "../../src/mcp/server.ts";
import { FakePageHandle } from "./fake-engine.ts";

export const fakeObservation = (hash: string): Observation => ({
  url: "http://fixture.test/start",
  title: "Fixture",
  readyState: "complete",
  epoch: 1,
  viewport: { width: 800, height: 600 },
  scroll: { x: 0, y: 0, maxY: 0 },
  elements: [],
  text: "Fixture content",
  headings: [],
  forms: [],
  signals: {
    passwordFieldVisible: false,
    modalOverlay: false,
    dialogOpen: false,
    iframeOrigins: [],
    scriptOrigins: [],
  },
  pageHash: hash,
  timings: { snapshotMs: 0, totalMs: 0 },
});

export function fakeMcpDeps(): McpDeps & { pages: FakePageHandle[]; launches: () => number } {
  const pages: FakePageHandle[] = [];
  let launches = 0;
  let samples = 0;
  let decisions = 0;
  const driver: EngineDriver = {
    kind: "fake",
    async launch(): Promise<BrowserHandle> {
      launches++;
      return {
        engine: { name: "fake", driver: "fake", stealthLevel: "high" },
        capabilities: new FakePageHandle().capabilities,
        selfCheck: { ok: true, checks: [] },
        connected: true,
        onDisconnected: () => () => {},
        newPage: async () => {
          const page = new FakePageHandle();
          pages.push(page);
          return page;
        },
        pages: () => pages,
        close: async () => {},
      };
    },
  };
  const engines = new EngineRegistry({ default: { driver: "fake", profile: {} } });
  engines.register(driver);
  const decisionPort = new MockDecider(() => {
    decisions++;
    return { answers: {} };
  });
  return {
    engines,
    decisionPort,
    pages,
    launches: () => launches,
    orchestrator: {
      observe: async () => fakeObservation(samples++ === 0 ? "start" : "changed"),
      detect: () => [],
      executeAction: async () => ({
        outcome: "changed",
        changes: { url: false, pageHash: true, value: false, checked: false },
        timings: { precheckMs: 0, inputMs: 0, settleMs: 0, harnessMs: 0 },
      }),
      buildDecisionState: () => ({ state: {}, questions: {}, reductions: [] }),
      interpret: () =>
        decisions === 1
          ? { type: "handoff", reason: "needs_values", source: "code", details: {} }
          : { type: "done_candidate", goalMet: 1 },
      pageMatches: async () => false,
    },
  };
}

export function answersFor(request: DecisionRequest): Answers {
  const answers: Answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "noul") {
      answers[id] = { noul: 0 };
      continue;
    }
    if (question.type === "score") {
      answers[id] = { score: 0, confidence: 1, probabilities: {} };
      continue;
    }
    const keys = Object.keys(question.criteria);
    const choice =
      id === "op" && keys.includes("CLICK")
        ? "CLICK"
        : id.endsWith("_target") && keys.includes("e1")
          ? "e1"
          : keys.includes("none")
            ? "none"
            : keys.includes("not_provided")
              ? "not_provided"
              : keys[0]!;
    answers[id] = {
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
    };
  }
  return answers;
}
