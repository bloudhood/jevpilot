# Configuration

All settings are environment variables of the server process. Unset optional settings use the defaults shown.

## Decision port

| Variable                 | Meaning                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `JEV_PROVIDER`           | Required for decisions: `typesafe`, `openrouter`, `cloudflare` or `custom`. `vercel` is reserved and currently rejected at startup.       |
| `JEV_API_KEY`            | Bearer key. Provider-specific fallbacks: `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `JEV_CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_TOKEN`.    |
| `CLOUDFLARE_ACCOUNT_ID`  | Required for `cloudflare`.                                                                                                                |
| `JEV_BASE_URL`           | Optional provider base URL; the full endpoint for `custom`.                                                                               |
| `JEV_MODEL`              | Model name. Default `jev-latest`.                                                                                                         |
| `JEV_FIRST_TIMEOUT_MS`   | Timeout of the first attempt. Default 5000 (or `JEV_TIMEOUT_MS` if that is smaller); each timed-out retry doubles it.                     |
| `JEV_TIMEOUT_MS`         | Longest single attempt. Default 20000.                                                                                                    |
| `JEV_MAX_RETRIES`        | Additional attempts. Default 2. A timed-out attempt is retried at once; HTTP 429/5xx and network errors back off and honor `Retry-After`. |
| `JEV_MAX_RETRY_AFTER_MS` | Longest `Retry-After` honored. Default 30000.                                                                                             |
| `JEV_CONTEXT_LIMIT`      | Optional token limit below the provider's built-in context limit.                                                                         |

## Browser and profile

| Variable                 | Meaning                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JEVPILOT_PROFILE_FILE`  | Path to a JSON browser profile (examples below). A profile file takes precedence over the default profile and ignores `JEVPILOT_EXTRA_ARGS`.                        |
| `JEVPILOT_BROWSER_PATH`  | Browser executable. Also overrides `executable` in a desktop profile file.                                                                                          |
| `JEVPILOT_USER_DATA_DIR` | Persistent browser profile directory. If unset, jevpilot creates a temporary profile and removes it on shutdown.                                                    |
| `JEVPILOT_DISPLAY`       | `headless` (default), `headed` (off-screen on Windows; existing display or Xvfb on Linux), or Linux-only `xvfb`. |
| `JEVPILOT_EXTRA_ARGS`    | Whitespace-separated browser flags added to the default profile, for example `--no-sandbox` in a container. The server refuses to start on flags it does not allow. |
| `JEVPILOT_ENGINE`        | Engine name; only `cdp` is registered in this release.                                                                                                              |

Default profiles: `desktop-chrome` on Windows (headless desktop at most `medium`; headed can reach `high`) and `server-plain` on Linux (stealth level `low`). Every launch runs a self-check.

A profile file selects `desktop-chrome`, `server-plain` or `attach`. Any Chromium-based browser works:
`desktop-chrome` accepts optional `display: "headless" | "headed"` (default `headless`); `server-plain` requires `display: "headless" | "xvfb"`.

Managed profiles disable Chrome password saving and leak detection; `attach` cannot change the external browser's Preferences.

| Browser                     | Profile file                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux server                | `{"kind":"server-plain","userDataDir":"/var/lib/jevpilot/chrome","windowSize":{"width":1280,"height":900},"display":"xvfb"}`                                                                                                                                                                                        |
| Microsoft Edge              | `{"kind":"desktop-chrome","executable":"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","userDataDir":"C:/browser-profiles/edge","windowSize":{"width":1280,"height":900}}` — keep Edge updated; an old version number is itself a fingerprint.                                                       |
| Fingerprint Chromium builds | `desktop-chrome` with `executable` pointing at the build and `extraArgs` such as `["--fingerprint=1234","--timezone=Asia/Shanghai"]`. Bind one seed to one `userDataDir` so an identity stays consistent. `--headless*`, `--disable-gpu` and `--enable-automation` are refused.                                     |
| Your own running browser    | `{"kind":"attach","cdpUrl":"http://127.0.0.1:9222"}`. Start it with `--remote-debugging-port=9222 --user-data-dir=<a separate directory>` (Chrome 136+ refuses remote debugging on the default profile). jevpilot never closes an attached browser; stealth level is `medium` because its launch flags are unknown. |

## Network safety and sessions

| Variable                            | Meaning                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JEVPILOT_NETWORK_GUARD`            | `metadata` (default) blocks cloud metadata addresses (169.254.0.0/16, 100.100.100.200, fd00:ec2::254) and allows localhost and private networks; `private` also blocks loopback, private, shared and link-local ranges; `off` disables the built-in ranges. |
| `JEVPILOT_BLOCKED_ADDRESSES`        | Extra comma-separated IPv4/IPv6 CIDRs to block in any mode.                                                                                                                                                                                                 |
| `JEVPILOT_ALLOWED_DOMAINS`          | Optional comma-separated domain allowlist for the whole server.                                                                                                                                                                                             |
| `JEVPILOT_MAX_SESSIONS`             | Concurrent sessions. Default 8. At the limit, idle sessions are reclaimed first, then `browser_run` fails with `too_many_sessions`.                                                                                                                         |
| `JEVPILOT_ISOLATED_SESSIONS`        | `1` opens each run in a fresh browser context without shared cookies.                                                                                                                                                                                       |
| `JEVPILOT_NAVIGATION_TIMEOUT_MS`    | Navigation timeout. Default 30000.                                                                                                                                                                                                                          |
| `JEVPILOT_ACTIONABILITY_TIMEOUT_MS` | How long an action waits for its target to become visible, stable and enabled. Default 2000.                                                                                                                                                                |
| `JEVPILOT_THRESHOLDS`               | Optional JSON object of confidence thresholds between 0 and 1 (see [docs/tools.md](tools.md)).                                                                                                                                                              |

Page loads (top-level documents, iframes, redirects, popups and downloads) are checked against the addresses their host resolves to before the request is sent, and again against the address the browser actually connected to. A blocked main-frame load ends the session with `BLOCKED_BY_POLICY`; nothing from that page is observed or returned. Subresource requests (scripts, images, `fetch`) are not checked, and behind a browser proxy only the pre-request check applies.

## HTTP transport

stdio is the default. `JEVPILOT_TRANSPORT=http` serves Streamable HTTP at `/mcp`.

| Variable                        | Meaning                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JEVPILOT_TRANSPORT`            | `stdio` (default) or `http`.                                                                                                                                                                 |
| `JEVPILOT_HTTP_HOST`            | Bind address. Default `127.0.0.1`.                                                                                                                                                           |
| `JEVPILOT_HTTP_PORT`            | Port. Default 8940; `0` picks a free port.                                                                                                                                                   |
| `JEVPILOT_HTTP_TOKEN`           | Required in HTTP mode, even on loopback (other local processes and web pages can reach localhost); at least 16 characters. Every request needs `Authorization: Bearer <token>`.              |
| `JEVPILOT_HTTP_ALLOWED_ORIGINS` | Comma-separated origins allowed to send an `Origin` header; any other origin is refused.                                                                                                     |
| `JEVPILOT_HTTP_ALLOWED_HOSTS`   | Extra accepted `Host` values. On a loopback bind only loopback names with the server's port are accepted (DNS-rebinding protection); on other binds the check applies only when this is set. |

There is no built-in TLS: expose a non-loopback bind only behind a TLS reverse proxy. All HTTP clients share the browser, its sessions and `JEVPILOT_MAX_SESSIONS`; one token is one user.

## Secrets and uploads

| Variable               | Meaning                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `JEVPILOT_SECRET_*`    | The only environment variables an `env:` secret reference may read.                                             |
| `JEVPILOT_SECRETS_DIR` | Root for `file:` secret references; real paths are checked, so `..` and links out of the directory are refused. |
| `JEVPILOT_UPLOAD_DIR`  | Root for files given to a page's file input; uploads are refused without it.                                    |

Literal typing into password fields is refused. Password values and resolved secrets never appear in observations or results.

## Usage detail and decision log

| Variable                | Meaning                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JEVPILOT_USAGE_DETAIL` | `1` adds per-call and per-session decision counts, tokens, timings and per-phase trace timings to results. Off by default to keep results small.                                                      |
| `JEVPILOT_DECISION_LOG` | JSONL file for decision records: session, step, question families, answer classes and confidence, outcome, latency, attempts and failure category. Page text, raw answers and keys are never written. |

## Linux server and Docker

Build the image from the repository; it contains Chromium, Xvfb and CJK fonts and runs Chromium under Xvfb on x64 and arm64. Run `doctor` first:

```sh
docker build -t jevpilot:runtime .
docker run --rm --init --shm-size=1g -e JEV_PROVIDER -e JEV_API_KEY jevpilot:runtime doctor
```

For remote MCP clients use the HTTP transport. Inside the container the server must bind all interfaces; publish the port on the host's loopback only (or behind a TLS proxy), and pass the token from the host environment:

```sh
docker run --rm --init --shm-size=1g -p 127.0.0.1:8940:8940 \
  -e JEVPILOT_TRANSPORT=http -e JEVPILOT_HTTP_HOST=0.0.0.0 -e JEVPILOT_HTTP_TOKEN \
  -e JEV_PROVIDER -e JEV_API_KEY jevpilot:runtime
```

```sh
claude mcp add --transport http jevpilot http://127.0.0.1:8940/mcp --header "Authorization: Bearer $JEVPILOT_HTTP_TOKEN"
```

## Check the setup

`jevpilot-mcp doctor` checks, with the same environment as the server: the Node version, every setting and its effective value, one real browser launch with its self-check, one minimal Jev call (latency and model; errors only by category) and the temp directory. `--no-browser` skips the launch and `--json` prints one JSON object. It exits with 1 when a check fails and never prints keys, tokens or secret values.

```sh
npx -y --package https://github.com/bloudhood/jevpilot/releases/download/v0.1.0/jevpilot-0.1.0.tgz jevpilot-mcp doctor
```

## Sessions

The stdio server launches the browser on the first `browser_run` and shares it across sessions, one tab per session; `JEVPILOT_ISOLATED_SESSIONS=1` gives each run a fresh browser context without shared cookies. `browser_run` returns a structured result: a status (for example `DONE_VERIFIED`, `NEEDS_VALUES`, `CONFIRM_REQUIRED`, `BLOCKED_BY_CHALLENGE`, `UNCERTAIN`), the reason, a question when input is needed, the URL, title, a compact page snapshot, a step trace, timings and token usage. Pass success conditions (`url_matches`, `text_present`, `element_present`) to get `DONE_VERIFIED` instead of `DONE_UNVERIFIED`.

Credentials go in `values` as secret references, not as text: `{ "secret_ref": "env:JEVPILOT_SECRET_SHOP_PASSWORD", "origins": ["https://shop.example"] }`. jevpilot types them on the listed origins only, and neither the agent nor Jev sees the value. Actions that look irreversible (buy, pay, send, delete) stop at `CONFIRM_REQUIRED` until the agent resumes with `allow_irreversible`.
Before submitting, jevpilot re-checks fields it typed and repairs page rewrites once.
