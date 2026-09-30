# Changelog

This project follows Keep a Changelog. Versions use Semantic Versioning.

## [Unreleased]

Fixes from a second code review, aimed at irreversible-action approval, secrets, the network guard and session state.

### Security

- Pressing Enter or Space (also in a chord such as Control+Enter) on a focused button or link that matches an irreversible action now waits for approval, whether or not the control is in a form and also for `type="button"` controls. Typing with `submit` into a form whose submit button is irreversible waits like Enter does, and elements the observer labels `clickable` (divs used as buttons) are matched like links.
- An approval is tied to the page it was raised on: `allow_irreversible` on `browser_resume` no longer runs a stored action on a different page.
- Secret redaction also covers a resolved secret that a page or URL echoes percent-encoded, form-encoded, with whitespace collapsed, or cut off after its first 8 or more characters, in results and in decision requests.
- The network guard no longer skips a host it could not resolve: when the browser resolves names itself, a lookup timeout or resolver failure (other than a missing name) fails the document, popup or download instead of letting it through. Adds the Azure WireServer address to the metadata list.
- Link targets that are not web addresses and form ids chosen by the page can no longer add lines or unquoted text to the questions sent to Jev.
- Token counts in a decision response must be finite and not negative, so they cannot lower the decision budget.

### Fixed

- Concurrent `browser_run` calls can no longer exceed `JEVPILOT_MAX_SESSIONS`.
- A session whose tab cannot be closed (already gone) is still released by `browser_close` and by idle reclamation, instead of staying registered and using up the session limit.
- When the browser disconnects, its sessions are closed so their handoff screenshots are removed.
- A dialog opened by a frame that goes away no longer blocks the page, and answering a dialog Chrome reports as no longer showing clears it instead of holding the session at the dialog handoff.
- A refused second launch of a browser profile no longer releases the profile of the browser that is using it.
- Two tests nested inside other tests (policy thresholds, observer shadow-root and delayed content) never ran; they run now.

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
