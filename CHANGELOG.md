# Changelog

This project follows Keep a Changelog. Versions use Semantic Versioning.

## [0.2.2] - 2026-10-03

Faster observations on long pages and ad-heavy pages; ad frames are no longer observed.

### Changed

- Observations skip ad frames: frames named by Google Publisher Tag or AdSense (`google_ads_iframe_…`, `aswift_…`), empty ad and consent plumbing frames, frames from a short list of ad-serving hosts, and frames nested in them are neither observed nor offered as candidates, and ad rotation no longer changes the page hash. Nothing else on the page is filtered, and every other operation (targets, success checks) still sees these frames. On an ad-heavy dictionary page a cold observation went from about 5.5 s to about 0.1 s. Ad frames are recognised as soon as they attach or navigate, so an observation does not wait for them to be set up.

### Fixed

- A frame that went away while it was still being set up (ad refreshes do this constantly) no longer makes every observation wait up to 1 s for it, and no longer holds other frame lookups until its CDP timeout. On an ad-heavy page the observations in the first seconds after loading went from 1.0–2.4 s to under 0.1 s.

- Observing a long page no longer takes seconds: the text of an element's container is read only until enough has been collected, instead of checking the visibility of every text node in the container for every element. On a long wiki article an observation went from about 5 s to about 0.2–0.6 s; what is observed is unchanged.

## [0.2.1] - 2026-10-03

Fixes for the confirmed findings of an external code review (issues #4–#14).

### Security

- Response headers named like tokens, secrets, sessions, credentials or API/access keys are dropped before the detectors see them.
- A browser profile's `extraArgs` can no longer override `--user-data-dir`, `--remote-debugging-port`, `--remote-debugging-pipe`, `--remote-debugging-address` or `--proxy-server`; the server refuses to start and names the flag (use the profile's `proxy` field for a proxy).
- SECURITY.md lists DNS rebinding between the network guard's lookup and the browser's connection as a known limit.

### Fixed

- A `browser_run` or `browser_resume` the client cancelled stops: a decision in progress is aborted and no further step starts, while an action already running finishes and is recorded. A cancelled `browser_run` still closes its session; a cancelled `browser_resume` keeps it. It used to keep deciding, clicking and typing until its budget ran out.
- After a CDP call times out, the pressed key and its modifiers, Control in select-all and drag interception are still released, without waiting for a busy page.
- An upload that times out still releases its remote object in the page.
- When the frame tree cannot be read, a navigation reports its own response status and headers, not a child frame's.
- Closing a session waits for all its tabs before removing its handoff screenshots, and a failure to remove them no longer replaces the real error or fails `browser_close`.
- A failed creation of the handoff screenshot directory is retried at the next handoff instead of disabling screenshots for the session.
- A retryable decision error (for example 429 with `retry-after`) stays retryable when its response body cannot be cancelled.
- Date values accept a one-digit month or day (`2024-1-1`) and years before 100.
- Values typed again and repeated futile submits are sent to the decision model once.
- Pages whose tab was closed outside jevpilot are forgotten; a failed browser identity probe no longer leaves an unhandled rejection.
- A `JEVPILOT_EXTRA_ARGS` value split at a space is refused with a pointer to `extraArgs` in a `JEVPILOT_PROFILE_FILE` profile.

### Changed

- docs/configuration.md explains that MCP clients cancel a tool call after their own request timeout (60 s in the TypeScript SDK), shorter than the default 180 s budget.
- SECURITY.md names 0.2.x as the supported release line.

## [0.2.0] - 2026-09-30

Fixes from a second code review and a review of those fixes, aimed at irreversible-action approval, secrets, the network guard, session state and the HTTP transport. Two configuration changes can stop an existing setup from starting: `JEVPILOT_HTTP_ALLOWED_HOSTS` on a non-loopback HTTP bind, and `JEVPILOT_BLOCKED_ADDRESSES` entries with host bits set.

### Security

- Pressing Enter or Space (also in a chord such as Control+Enter) on a focused button or link that matches an irreversible action now waits for approval, whether or not the control is in a form and also for `type="button"` controls. Typing with `submit` into a form whose submit button is irreversible waits like Enter does, and elements the observer labels `clickable` (divs used as buttons) are matched like links. An approved key press is sent to the approved control even when focus moved in between, and a form's submit controls are checked even when they are outside the observation (for example a Place order button far below the viewport).
- An approval is tied to the page it was raised on: `allow_irreversible` on `browser_resume` no longer runs a stored action on a different page.
- Secret redaction also covers a resolved secret that a page or URL echoes percent-encoded, form-encoded or with whitespace collapsed, and one the observer cut short after its first 8 or more characters (text it cuts now ends with "…"), in results and in decision requests. A password that starts with an ordinary word no longer rewrites labels or the field type, and when one secret extends another the longer one is redacted first.
- In `private` mode the network guard no longer skips a host it could not resolve: when the browser resolves names itself, a lookup timeout or resolver failure (other than a missing name) fails the document, popup or download. The default `metadata` mode still loads such a host, because the browser may reach it through a system or environment proxy the guard cannot see. Adds the Azure WireServer address to the metadata list.
- Link targets that are not web addresses and form ids chosen by the page can no longer add lines or unquoted text to the questions sent to Jev.
- Token counts in a decision response must be finite and not negative, so they cannot lower the decision budget.
- The HTTP transport refuses to start on a non-loopback bind (including `0.0.0.0`) unless `JEVPILOT_HTTP_ALLOWED_HOSTS` lists the accepted `Host` values, so a network-facing endpoint no longer relies on the token alone against DNS rebinding. The Docker example in the configuration guide sets it.
- In `private` mode the network guard also blocks 6to4 (`2002::/16`), IPv4-compatible (`::/96`) and RFC 8215 NAT64 (`64:ff9b:1::/48`) addresses, which can embed a private IPv4 address.
- The network guard resolves a host the way the browser does when the browser flags contain `--host-resolver-rules` (`MAP` and `EXCLUDE`, with `*` and `?` patterns, first match wins), so a mapped name is checked against the address it is mapped to instead of what DNS says about the original name. Rules with spaces belong in a profile file's `extraArgs`; `JEVPILOT_EXTRA_ARGS` splits on whitespace.

### Added

- `JEV_BREAKER_THRESHOLD` and `JEV_BREAKER_COOLDOWN_MS` tune the decision circuit breaker (defaults unchanged: 3 failures, 30 s).
- The runtime image has a health check that probes the HTTP endpoint when `JEVPILOT_TRANSPORT=http`.

### Changed

- `JEVPILOT_BLOCKED_ADDRESSES` entries whose host bits are set (for example `10.0.0.1/8`) are refused at startup; write `10.0.0.0/8`.
- The HTTP transport keeps at most 64 MCP client sessions. When it is full, a new client replaces the least recently used idle session; it gets 503 only when every session has a request in flight. This is separate from `JEVPILOT_MAX_SESSIONS`, which limits browser sessions.
- CI builds the runtime image and checks that it serves the MCP tools over stdio.

### Fixed

- Concurrent `browser_run` calls can no longer exceed `JEVPILOT_MAX_SESSIONS`.
- A session whose tab cannot be closed (already gone) is still released by `browser_close` and by idle reclamation, instead of staying registered and using up the session limit.
- When the browser disconnects, its sessions are closed so their handoff screenshots are removed.
- A dialog opened by a frame that goes away no longer blocks the page, and answering a dialog Chrome reports as no longer showing clears it instead of holding the session at the dialog handoff.
- A refused second launch of a browser profile no longer releases the profile of the browser that is using it.
- Two tests nested inside other tests (policy thresholds, observer shadow-root and delayed content) never ran; they run now.
- Stopping the HTTP server no longer waits forever for open event streams, closing an idle MCP session cannot raise an unhandled rejection, and a socket error after startup is logged instead of crashing the process.
- After an uncaught exception the process exits within 30 seconds even when a graceful shutdown hangs.
- A `browser_run` the client cancelled, or whose browser disconnected during the initial navigation, no longer leaves a session behind that holds a place in `JEVPILOT_MAX_SESSIONS`.
- A request that ends after its MCP session was deleted or replaced no longer puts the closed session back.
- A rejected download in an isolated session is cancelled in its own browser context; it used to keep downloading.
- Only the decision circuit breaker's half-open probe clears its probe state, so an older failing request cannot let a second probe through.
- `jevpilot-mcp doctor` also hides the values of any environment variable named like a key, token, secret or password, and reports a browser-profile cleanup failure as `browser-profile` instead of `temp`.
- The refusal of `JEVPILOT_EXTRA_ARGS` names the rejected flag, an invalid browser profile no longer leaves its temporary directory behind, and an invalid `JEVPILOT_THRESHOLDS` is reported as a startup message instead of a stack trace.
- Error messages that hide `password=...` and similar pairs keep the key name instead of printing a literal `$1`, and a failing browser close is logged without raw error text.
- A handoff screenshot directory is no longer left registered when its session closes while the directory is being created.
- The MCP server reports the version from `package.json` instead of a hardcoded `0.1.0`.

## [0.1.1] - 2026-09-29

Fixes from a multi-reviewer code review of 0.1.0.

### Security

- A secret is sent only to a frame or prompt of an origin it is bound to: a field inside a cross-origin iframe, or a prompt opened by a child frame, no longer receives a secret bound to the top-level page.
- Secret redaction covers every field of what is sent to the decision model and returned to the agent, including option labels, nearby text, links, result URLs and titles, and tab lists.
- Pressing Enter in a form field goes through the same approval as submitting the form, so buy, pay and delete forms cannot be sent with Enter without approval.
- If the network guard cannot be enabled for a page, the page is closed (or the child frame blocked) instead of being used without it.
- Rejected HTTP requests no longer leave MCP server instances behind.

### Fixed

- A page that keeps navigating no longer keeps `browser_run` from returning.
- Concurrent calls on the same session run one after another.
- A decision call stops when the session's time budget runs out. Invalid answers and cancelled calls no longer open the decision circuit for every session.
- Decision requests are reduced against the configured provider and `JEV_CONTEXT_LIMIT`, which can no longer exceed the provider's limit.
- Success checks ignore hidden elements and hidden text, and also look inside cross-origin iframes.
- Clicks inside scaled iframes land on their target, typing into rich-text (contenteditable) editors is recognised, and native selects skip disabled options.
- Attach mode leaves the external browser as it found it: closing, also after a failed launch, restores its default download behaviour and closes what jevpilot opened.
- `doctor` reports an unsupported `JEVPILOT_ENGINE`.
- Shutdown closes the MCP transport even when closing the browser fails; popups that fail to attach and unmatched download events no longer leak.

### Changed

- CI also checks formatting, types and the build.

## [0.1.0] - 2026-09-29

### Added

- MCP tools for goal-driven browser sessions, manual browser actions, observation, navigation, tab management, and direct Jev decisions.
- Jev decision integration with bounded retries, a short first-attempt timeout that doubles per retry, answer validation and optional usage details.
- Windows desktop Chrome and Linux Chromium profiles. The browser runs headless by default, with the same user agent and client hints as headed Chrome and a screen at least as large as the window; `JEVPILOT_DISPLAY=headed` runs a headed browser instead (kept off-screen on Windows). A Dockerfile for Linux x64 and arm64 runs Chromium under Xvfb (build locally).
- Streamable HTTP transport with bearer-token authentication.
- A doctor command for configuration, browser and decision-service checks.
- Session handoffs for uncertainty, missing values, login, challenges, domain approval and irreversible actions.
- Recovery from a lost browser: sessions on it report `browser_disconnected` and the next run relaunches the browser.
- Typed text reaches widgets that listen for key events (date pickers, masks), and fields the page rewrote are re-typed once before a form is submitted, or handed back.
- Managed Chrome profiles turn off Chrome's password manager, whose leak warning dialog would otherwise block all input after a login.
- `scripts/soak.mjs`: long-run, fault-injection and concurrency check against a local fake Jev endpoint.
- MIT license and documentation for configuration, tools, privacy and architecture.

### Security

- Document-navigation network guard with metadata protection by default and an optional stricter private-address mode.
- HTTP Origin and Host checks, required HTTP token, and loopback bind by default.
- Restricted secret references, redaction of resolved secrets, and upload paths limited to a configured directory.
- Session limits, idle reclamation and temporary-directory ownership checks.
- No tool for evaluating arbitrary JavaScript in the browser.
