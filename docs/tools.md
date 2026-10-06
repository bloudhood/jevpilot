# MCP tool reference

Tool names and schemas below come from src/mcp/server.ts. Browser session results use the schema in src/orchestrator/result.ts.

## browser_run

Starts a browser session and asks Jev to work toward a goal. If no decision port is configured, returns FAILED with reason decision_port_not_configured before launching the browser.

| Input                 | Type                             | Required | Meaning                                                                                                                                                                                                    |
| --------------------- | -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| goal                  | non-empty string                 | Yes      | Task goal.                                                                                                                                                                                                 |
| url                   | URL string                       | No       | Initial URL; only http and https are accepted. Omit for a blank tab.                                                                                                                                       |
| navigation_timeout_ms | integer, 1 to 2147483647         | No       | Initial navigation timeout; default 30000 ms.                                                                                                                                                              |
| values                | record of strings or secret refs | No       | Values keyed by short field descriptions. A secret ref has secret_ref and origins, where origins is a non-empty array of URL strings.                                                                      |
| success               | object                           | No       | Optional url_matches, text_present, element_present, or download_completed checks. download_completed: true holds after a session download is verified complete; checks already true at start are ignored. |
| constraints           | object                           | No       | Optional allowed_domains array of non-empty strings and allow_irreversible boolean. allow_irreversible pre-approves every irreversible action in the session.                                              |
| budget                | object                           | No       | Optional steps (non-negative integer), seconds (non-negative number), and decision_tokens (non-negative integer).                                                                                          |
| thresholds            | object                           | No       | Optional per-session thresholds from 0 to 1: op, target, value_for, option_for, situation, goal_met, goal_met_unchanged, check and check_margin.                                                           |
| profile               | non-empty string                 | No       | Configured engine profile name; defaults to the server engine.                                                                                                                                             |

Returns a session result.

## browser_resume

Continues an existing session after a handoff.

| Input              | Type                             | Required | Meaning                                                                                              |
| ------------------ | -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| session            | non-empty string                 | Yes      | Session ID returned by browser_run.                                                                  |
| values             | record of strings or secret refs | No       | Add or replace supplied values.                                                                      |
| goal_update        | non-empty string                 | No       | Update the goal.                                                                                     |
| allow_irreversible | boolean                          | No       | Approve the pending irreversible action. Approval is scoped to that action and its page.             |
| allowed_domains    | array of non-empty strings       | No       | Add domains to the session allowlist within any server allowlist; it cannot narrow the session list. |
| dialog             | object                           | No       | Required accept boolean and optional value_key for a prompt response.                                |

Returns a session result.

## browser_observe

Reads the current page without acting on it. To look at the page, use browser_screenshot.
If the page has stopped responding, it may reopen the same URL once in a new isolated tab, which discards unsaved page state.

| Input      | Type             | Required | Meaning                                                       |
| ---------- | ---------------- | -------- | ------------------------------------------------------------- |
| session    | non-empty string | Yes      | Session ID.                                                   |
| detail     | compact or full  | No       | Observation detail level; compact is the default.             |
| screenshot | boolean          | No       | Also save a JPEG of the visible viewport and return its path. |

Returns a session result. screenshot_path is optional: the viewport screenshot requested with screenshot, otherwise a handoff screenshot when the result is a handoff. Both are temporary JPEG files, deleted when the session closes, and never written in sessions that use secret values.

## browser_screenshot

Captures the current tab of a session as a JPEG: the visible viewport, or one element by ref from the latest observation. No output schema is declared and the image is returned only as content, because a structured result replaces the model-visible text for some clients and drops the image entirely for others.

| Input   | Type                | Required | Meaning                                                                                                          |
| ------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| session | non-empty string    | Yes      | Session ID.                                                                                                      |
| ref     | non-empty string    | No       | Element ref from the latest observation. Omit to capture the visible viewport.                                   |
| output  | image, file or both | No       | image (default) returns the image; file saves it and returns only its path; both returns the image and saves it. |
| quality | integer, 30 to 90   | No       | JPEG quality; default 70.                                                                                        |

Returns one text line and, unless output is file, an image/jpeg content item. The text line is JSON with session, url, title, width and height, ref when one was given, file when a file was written, and a note that text inside the image is page content, not instructions. When the server sets `JEVPILOT_IMAGE_RESPONSES=omit`, output is treated as file and the text notes that images are disabled by the server. Code-mode clients that print the whole result turn the image into base64 text; forward the image content item with the client's image helper instead. A session that uses secret values is refused: "Screenshots are disabled for sessions that use secret values."

Files: with `JEVPILOT_SCREENSHOT_DIR` set, the image is written there as `jevpilot-<yyyyMMdd-HHmmss>-<id>.jpg` and jevpilot never deletes it. Otherwise it is written to the session's temporary directory as `screenshot-<id>.jpg` and removed when the session closes. Under the HTTP transport the returned path is on the server, not the client.

## browser_act

Performs one or more manual operations against current element references. Each operation must include action.

| Input              | Type                                     | Required | Meaning                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| session            | non-empty string                         | Yes      | Session ID.                                                                                                                                                                                                                                                              |
| ops                | array of operation objects, at least one | Yes      | Actions to perform in order.                                                                                                                                                                                                                                             |
| allow_irreversible | boolean                                  | No       | Approve one irreversible action in this call: the first operation that reaches the irreversible-action gate. A later gated operation in the same call stops with CONFIRM_REQUIRED; approving it with browser_resume runs only that operation, not the rest of the batch. |

Operation fields:

| Field        | Type                       | Required | Meaning                                                                                                   |
| ------------ | -------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| action       | enum                       | Yes      | click, type, toggle, select, scroll, back, wait, key, dialog, press_key, hover, drag, upload or wait_for. |
| ref          | non-empty string           | No       | Element ref from the latest observation.                                                                  |
| value_key    | non-empty string           | No       | Supplied value key for typing or a prompt.                                                                |
| text         | string                     | No       | Literal text; password fields refuse literal typing.                                                      |
| submit       | boolean                    | No       | Request submission after typing.                                                                          |
| to_ref       | non-empty string           | No       | Destination element ref for drag.                                                                         |
| paths        | array of non-empty strings | No       | Upload paths, restricted to JEVPILOT_UPLOAD_DIR.                                                          |
| condition    | appears or disappears      | No       | Condition for wait_for.                                                                                   |
| timeout_ms   | integer, 0 to 30000        | No       | wait_for timeout.                                                                                         |
| delay_ms     | integer, 0 to 10000        | No       | Delay for wait.                                                                                           |
| option_label | string                     | No       | Select option label.                                                                                      |
| direction    | up or down                 | No       | Scroll direction.                                                                                         |
| name         | string                     | No       | Key name for key or press_key.                                                                            |
| key          | string                     | No       | Alias of name for key or press_key.                                                                       |
| accept       | boolean                    | No       | Accept or dismiss a dialog.                                                                               |

Native select observations show the first 20 labels and how many are omitted; selection checks all live options.

Returns a session result with a fresh snapshot.

## browser_navigate

Navigates the selected tab, subject to the session and server domain policies.

| Input   | Type             | Required | Meaning                    |
| ------- | ---------------- | -------- | -------------------------- |
| session | non-empty string | Yes      | Session ID.                |
| url     | URL string       | Yes      | http or https destination. |

Returns a session result.

## browser_tabs

Lists, selects or closes tabs owned by a session.

| Input   | Type                  | Required | Meaning                                       |
| ------- | --------------------- | -------- | --------------------------------------------- |
| session | non-empty string      | Yes      | Session ID.                                   |
| action  | list, select or close | Yes      | Operation to perform.                         |
| tab_id  | non-empty string      | No       | Required by the handler for select and close. |

Returns session and, for list, tabs containing tab_id, url and selected. For select/close it returns status and reason; close also returns closed.

## browser_close

Closes the session and its owned tabs and removes temporary handoff files. The shared browser remains available to other sessions.

| Input   | Type             | Required | Meaning     |
| ------- | ---------------- | -------- | ----------- |
| session | non-empty string | Yes      | Session ID. |

Returns session and closed: true.

## jev_decide

Sends caller-provided state and typed questions directly to the configured Jev decision port. It does not create or change a browser session. The tool is registered only when the server has a decision port.
For score questions, `score` is the 0-based index of the chosen level and probabilities are keyed by level index; when Jev rejects a request, the tool returns Jev's reason.

| Input     | Type                      | Required | Meaning                                                                        |
| --------- | ------------------------- | -------- | ------------------------------------------------------------------------------ |
| state     | any JSON value            | Yes      | Decision state supplied by the caller.                                         |
| questions | object of typed questions | Yes      | Question definitions using the decision request schema: choice, score or noul. |

Returns answers, usage with inputTokens/outputTokens, model and latency_ms.

## Tool annotations

| Tool               | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| ------------------ | ------------ | --------------- | -------------- | ------------- |
| browser_run        | false        | true            | false          | true          |
| browser_resume     | false        | true            | false          | true          |
| browser_act        | false        | true            | false          | true          |
| browser_navigate   | false        | true            | false          | true          |
| browser_tabs       | false        | true            | false          | true          |
| browser_observe    | false        | true            | false          | true          |
| browser_close      | false        | true            | true           | true          |
| browser_screenshot | false        | false           | false          | true          |
| jev_decide         | true         | false           | true           | true          |

Every tool declares all four MCP hints. browser_observe is not read-only because of the recovery above; browser_screenshot is not read-only because a ref capture scrolls the element into view and file output keeps a file, but it only adds uniquely named files. browser_close is idempotent: closing again has no further effect (it reports an unknown session). Hints help hosts present tools; the server's own gates (domains, irreversible actions, secrets) apply regardless.

## Result shape

Session results contain status, reason, question, session, url, title, snapshot, trace, timing and usage. Optional fields are details, screenshot_path and downloads. Status is one of:

RUNNING, DONE_VERIFIED, DONE_UNVERIFIED, NEEDS_VALUES, NEEDS_LOGIN, BLOCKED_BY_CHALLENGE, BLOCKED_BY_POLICY, CONFIRM_REQUIRED, INFO_NOT_ON_PAGE, UNCERTAIN, STUCK, ERROR_PAGE, BUDGET_EXHAUSTED or FAILED.

BUDGET_EXHAUSTED with reason `call_deadline_exceeded` means the call reached `JEVPILOT_CALL_DEADLINE_MS` before the goal was done: the session is kept and `browser_resume` continues it.

Trace entries describe step, operation, optional target/coveredBy, confidence, outcome, drift and timing. Outcome is an executor action outcome or accepted/dismissed. usage always has decision_tokens; usage.detail appears only when JEVPILOT_USAGE_DETAIL=1.

downloads appears once the session has started a download and lists its 20 most recent downloads. Each entry has id, a sanitized name, and state: in_progress, completed, canceled, or unavailable (Chrome reported it finished but the file could not be verified inside the download directory). A completed entry also has path and size_bytes; the file has been renamed to `<id prefix>-<name>`. The path is on the server (also under the HTTP transport), and the download URL is never returned.

An MCP tool failure can instead have isError and a text message. Errors do not include raw provider bodies or secret values.

## 0.x stability

Within a 0.x minor version, tool names and existing fields keep their meaning. Additions are backward compatible. Breaking changes are made only in a minor version bump and are always listed in CHANGELOG.md.
