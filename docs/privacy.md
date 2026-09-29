# Privacy and data flows

This page describes data flows visible in the source. Browser behavior and the behavior of remote sites are not fully controlled by jevpilot.

## Data sent to Jev

### browser_run and browser_resume decisions

For each decision step, jevpilot sends state and typed questions to the configured decision endpoint. A low-confidence answer can cause an additional candidate-check request. Retried attempts can resend the same request. The request is constructed in createDecisionPort and sendWithRetry (src/decision/port.ts and src/decision/transport.ts); provider-specific URL and body construction is in prepareRequest (src/decision/adapters.ts).

- The agent's goal is sent as provided, as agent_goal and in question instructions. The session assembles it in runLoop (src/orchestrator/session.ts); buildDecisionState and buildQuestions add it to state/questions (src/policy/index.ts). Do not put credentials in the goal; goal text is not scrubbed as a secret value.
- The page observation includes the current URL and title, selected page text, visible/nearby element labels, roles, link destinations, selected options, and non-password form-control values when present. It is formatted by formatObservation (src/observer/format.ts), sourced from pageSnapshot and observe (src/observer/page-snapshot.ts and src/observer/observe.ts), and placed in state by buildDecisionState (src/policy/index.ts).
- The observation is selected and bounded. Compact observation defaults to at most 1500 text characters and selected elements in observe (src/observer/observe.ts). formatObservation also applies a default 3000-token formatting budget (src/observer/format.ts). Decision state/questions are reduced to provider token limits in buildDecisionState (src/policy/index.ts and src/decision/limits.ts). Actual request size varies by page and provider.
- Questions may quote page-derived labels, option labels, and a currently displayed field value (up to 60 characters for the value question). buildQuestions constructs these fields (src/policy/index.ts).
- Supplied values are not sent as a separate values map. The request contains the supplied key names and whether each key is secret, from the value_keys field in buildDecisionState (src/policy/index.ts). A plain value can still appear in page observation after it has been typed if it is visible in a non-password field.
- Password values are masked when pageSnapshot reads the control (src/observer/page-snapshot.ts). Resolved secret literals are scrubbed from observation fields in sanitizedObservation (src/orchestrator/session.ts). The policy excludes password values from its formatted state (src/policy/index.ts).
- Screenshots, cookies, local storage, browser profile files and upload file contents are not fields in the decision request. The request body is built from model/state/questions in prepareRequest (src/decision/adapters.ts).
- The decision API key is sent as an Authorization bearer header by sendWithRetry (src/decision/transport.ts). It is not included in the JSON request body.

The source does not guarantee that every arbitrary secret-looking string is detected as a secret. Use secret_ref for sensitive values and ensure the target is recognized as a password-like field; review the page's returned observation before continuing.

### jev_decide

jev_decide sends the caller-provided state and questions to the decision port and does not inspect a browser (handler in src/mcp/server.ts). Its input follows requestSchema (src/decision/types.ts). The caller can put any data in state or questions, so the exact content is determined by the caller. The returned tool fields are answers, usage, model and latency_ms (src/mcp/server.ts). The key is sent in the Authorization header as above.

### doctor decision check

jevpilot-mcp doctor makes one decision call when JEV_PROVIDER is configured. The state is the literal value doctor and it asks one fixed readiness choice; runDoctor builds this request (src/mcp/doctor.ts). It sends no page URL, title, text, values or screenshot. The configured decision port sends its provider request through createDecisionPort (src/decision/port.ts).

## Data sent to websites

Navigation, page scripts, forms and other browser activity can send data to the site and its resources. The browser is launched or attached by the engine and CDP driver (src/engine/default.ts, src/engine/cdp/driver.ts, src/browser). The source guard checks document navigation addresses but does not check subresource requests such as scripts, images or page fetch calls (parseNetworkGuard in src/mcp/network-guard.ts, address checks in src/security/address-guard.ts, and request interception in src/engine/cdp/driver.ts).

When an agent requests a file upload, jevpilot accepts only a path under JEVPILOT_UPLOAD_DIR and passes that file to a file input through the CDP driver (src/orchestrator/session.ts and src/engine/cdp/driver.ts). The file contents are then available to the page and may be submitted to its site. Which network request the site makes is not determined by jevpilot's source.

Which cookies, headers, scripts, or other data an arbitrary site sends or receives depends on the browser profile, page code, extensions, proxy and site behavior. This repository cannot determine that for every destination.

## Data returned to the MCP caller

Session results can include status, reason, question, URL, title, a text snapshot, trace, timings, usage, and sometimes a local screenshot path. The result is assembled in result (src/orchestrator/session.ts) and validated by sessionResultSchema (src/orchestrator/result.ts). Resolved secrets are scrubbed before results are built (src/orchestrator/session.ts). browser_observe can create a local screenshot file when requested and supported (src/mcp/server.ts).

## Local data

- Browser profile: Chrome/Chromium owns cookies, cache and other profile data under the configured userDataDir. If JEVPILOT_USER_DATA_DIR or a profile's userDataDir is persistent, the profile remains after a server run. The exact browser-managed contents are outside jevpilot's source.
- Downloads: launched desktop/server profiles use their configured downloadPath or a downloads directory under userDataDir. An attached browser does not manage downloads unless its driver is explicitly configured to do so (profile setup in src/browser/launcher.ts and profile types in src/browser/profiles.ts). An attached browser retains its own profile and download configuration.
- Screenshots and temporary profiles: handoff/observation screenshots and default browser profiles use owned temporary directories. They are removed on normal session/server cleanup; stale owned directories are swept at startup (src/util/owned-temp.ts, src/mcp/server.ts and src/mcp/main.ts). A crash can leave temporary data until a later cleanup.
- Decision log: when JEVPILOT_DECISION_LOG is set, JSONL records contain decision/session type, session ID, step, question families, selected answer classes, confidence, top-two margin, Noul values, outcome, latencyMs and attempts; failed decisions also include error_category. Session-end records contain final status and whether success assertions held. These records are built by calibrationRequestRecord and the session result path (src/orchestrator/decision-log.ts and src/orchestrator/session.ts). The log does not store page text, raw questions, raw choice answers, API keys or response bodies.
- Secret files: file-based secrets are read from beneath JEVPILOT_SECRETS_DIR for a requested action; the secret value is held in memory for the session (resolveValue in src/orchestrator/session.ts). The source does not persist a copy of the secret.

## Telemetry

jevpilot has no telemetry or analytics. A search of src for fetch calls, HTTP request APIs, WebSocket construction, DNS lookups and network connect calls finds only these outbound connections:

- the Jev decision request in sendWithRetry (src/decision/transport.ts);
- the CDP WebSocket to the browser (src/browser/cdp/client.ts);
- for an `attach` profile with an `http://` cdpUrl, one `GET /json/version` to that address to discover the WebSocket URL (launchBrowser in src/browser/launcher.ts);
- DNS lookups of the host name of each page load (top-level documents, iframes, popups, downloads), made by the network guard through the system resolver before the browser connects; skipped for IP-address hosts and when the guard is `off` with no extra blocked ranges (blockedUrl in src/security/address-guard.ts).

The MCP HTTP transport (src/mcp/http.ts) only listens. This statement covers jevpilot's own source; it does not cover dependencies or the browser's own network activity.
