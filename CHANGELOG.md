# Changelog

This project follows Keep a Changelog. Versions use Semantic Versioning.

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
