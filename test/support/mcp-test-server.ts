import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCdpDriver } from "../../src/engine/cdp/driver.ts";
import { EngineRegistry } from "../../src/engine/registry.ts";
import { MockDecider } from "../../src/decision/mock.ts";
import { createServer } from "../../src/mcp/server.ts";
import { installProcessSafety } from "../../src/mcp/process-safety.ts";
import { CdpTimeoutError } from "../../src/browser/errors.ts";
import { answersFor, fakeMcpDeps, fakeObservation } from "./mcp-fixture.ts";
import { testProfile } from "./browser-profile.ts";

const real = process.env.JEVPILOT_TEST_REAL === "1";
const deps = real
  ? (() => {
      const engines = new EngineRegistry({
        default: {
          driver: "cdp",
          profile: {
            ...testProfile(process.env.JEVPILOT_USER_DATA_DIR ?? "", { width: 1000, height: 700 }),
            // This server builds its profile itself, so loadMcpProfile's JEVPILOT_DOWNLOAD_DIR
            // handling (unit-tested) does not run; apply the same effect here.
            ...(process.env.JEVPILOT_DOWNLOAD_DIR
              ? { downloadPath: process.env.JEVPILOT_DOWNLOAD_DIR }
              : {}),
            executable: process.env.JEVPILOT_BROWSER_PATH,
            extraArgs: [
              ...(testProfile("").extraArgs ?? []),
              "--no-proxy-server",
              "--disable-background-networking",
            ],
          },
        },
      });
      engines.register(createCdpDriver());
      return {
        engines,
        decisionPort: new MockDecider((request) => ({ answers: answersFor(request) })),
      };
    })()
  : fakeMcpDeps();
const app = createServer(deps);
let stopping: Promise<void> | undefined;
const stop = () => (stopping ??= app.close());
installProcessSafety(stop);
if (
  !real &&
  (process.env.JEVPILOT_TEST_LATE_REJECTION === "1" || process.env.JEVPILOT_TEST_UNCAUGHT === "1")
) {
  const fake = deps as ReturnType<typeof fakeMcpDeps>;
  let fired = false;
  fake.orchestrator!.observe = async () => {
    if (!fired) {
      fired = true;
      if (process.env.JEVPILOT_TEST_UNCAUGHT === "1")
        setTimeout(() => {
          throw new CdpTimeoutError("SECRET_MARKER");
        }, 0);
      else
        setTimeout(() => {
          void Promise.reject(new CdpTimeoutError("SECRET_MARKER"));
        }, 0);
    }
    return fakeObservation("start");
  };
}
process.stdin.once("end", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
await app.server.connect(new StdioServerTransport());
