import type { ToolHost } from "../host.ts";
import act from "./act.ts";
import close from "./close.ts";
import decide from "./decide.ts";
import navigate from "./navigate.ts";
import observe from "./observe.ts";
import resume from "./resume.ts";
import run from "./run.ts";
import screenshot from "./screenshot.ts";
import tabs from "./tabs.ts";

export type ToolModule = {
  name: string;
  /** The tool is not mounted when a listed dependency is missing (e.g. no decision service). */
  requires?: readonly "decisionPort"[];
  apply(host: ToolHost): void;
};

// The order fixes the tools/list output; see test/mcp/fixtures/tools-list.json.
export const builtinTools: ToolModule[] = [
  run,
  resume,
  observe,
  screenshot,
  act,
  navigate,
  tabs,
  close,
  decide,
];
