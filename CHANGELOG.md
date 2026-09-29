# Changelog

This project follows Keep a Changelog. Versions use Semantic Versioning.

## [0.1.0] - 2026-09-29

### Added

- MCP tools for goal-driven browser sessions, manual browser actions, observation, navigation, tab management, and direct Jev decisions.
- Jev decision integration with bounded retries, a short first-attempt timeout that doubles per retry, answer validation and optional usage details.
- Windows desktop Chrome and Linux Chromium profiles. The browser runs headless by default, with the same user agent, client hints and screen size as headed Chrome; `JEVPILOT_DISPLAY=headed` runs a headed browser instead (kept off-screen on Windows). A Dockerfile for Linux x64 and arm64 runs Chromium under Xvfb (build locally).
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
