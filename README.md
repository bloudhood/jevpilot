# jevpilot — a fast Jev browser MCP for agents

English | [简体中文](README.zh-CN.md)

jevpilot is an MCP server that gives an agent a browser that finishes tasks on its own. The agent sends a goal; jevpilot drives a real Chrome step by step, with [Jev](https://typesafe.ai) choosing each action, and returns a verified result or a concrete question.

jevpilot is not an official TypeSafe project. Jev is TypeSafe's paid model; you need a key from the TypeSafe API or OpenRouter.

## Highlights

- **Goal-level tasks.** One tool call per task instead of one per click; Jev picks each step in about 0.3–0.9 s.
- **Hands back instead of guessing.** When unsure, missing a value or needing approval, the session stops with a clear status and question, and the agent resumes the same session.
- **Safety rules before the model.** Login walls, bot challenges and error pages are detected by rules; buy, pay and delete buttons wait for approval; typed fields are re-checked before a form is submitted.
- **Secrets stay out of prompts.** Passwords are passed as references and typed by the server on the sites you allow; neither the agent nor Jev sees them.
- **Network guard.** Cloud metadata addresses are blocked by default, with an optional private-network mode and a domain allowlist.
- **Desktop and server.** Headless Chrome by default on Windows and Linux; the Docker image runs Chromium under Xvfb; stdio or token-protected HTTP.
- **Easy to operate.** Recovers from a browser crash, `jevpilot-mcp doctor` checks the setup, optional usage and decision logs, no telemetry.

## Why not just Playwright MCP?

With [Playwright MCP](https://github.com/microsoft/playwright-mcp) the agent reads every page and issues every click itself. With jevpilot the agent delegates the whole task:

|                                                  | Playwright MCP                  | jevpilot                                     |
| ------------------------------------------------ | ------------------------------- | -------------------------------------------- |
| Who plans each click                             | the agent                       | Jev, inside the server                       |
| Tool calls per task                              | 7.1                             | 1.5                                          |
| Agent tokens per task                            | 49k                             | 11k                                          |
| Success rate, multi-step tasks                   | 83%                             | 100%                                         |
| Success rate, real sites not used in development | 66%                             | 89%                                          |
| Success rate, sites behind bot protection        | 0%                              | 100%                                         |
| Median time per task, multi-step / real sites    | 9.0 s / 16.9 s                  | 5.1 s / 9.6 s                                |
| Passwords                                        | plain text in the agent context | typed by the server, never seen by the agent |
| Buy / pay / delete buttons                       | up to the agent                 | wait for the agent's approval                |
| Bot challenges and login walls                   | the agent has to notice         | detected and handed back with the reason     |

Measured in September 2026 on Windows, both sides running headless Chrome and driven by the same agent model, back to back. Small samples on public sites: treat the numbers as indicative.

## Platforms and browser

| Platform          | Default browser                                                                | How it runs                                          |
| ----------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Windows x64       | Google Chrome (Microsoft Edge if Chrome is not installed)                      | headless by default, temporary profile               |
| Linux x64 / arm64 | `google-chrome` or `chromium` from `PATH` (the Docker image includes Chromium) | headless by default; Docker runs Chromium under Xvfb |
| macOS             | not supported yet                                                              |                                                      |

Any other Chromium-based browser, a persistent profile or your own running browser can be configured: see [Configuration](docs/configuration.md). Node.js 22 or newer is required.
Set `JEVPILOT_DISPLAY=headed` to use a headed browser (off-screen on Windows, Xvfb or an existing display on Linux).

## Quick start

Install from npm and add it to your MCP client. Keep the key in your environment rather than in the file.

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "jevpilot": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "jevpilot@0.4.0",
        "jevpilot-mcp"
      ],
      "env": { "JEV_PROVIDER": "openrouter", "JEV_API_KEY": "${JEV_API_KEY}" }
    }
  }
}
```

Codex (`config.toml`):

```toml
[mcp_servers.jevpilot]
command = "npx"
args = ["-y", "--package", "jevpilot@0.4.0", "jevpilot-mcp"]
env = { JEV_PROVIDER = "openrouter" }
env_vars = ["JEV_API_KEY"]
```

Use `JEV_PROVIDER=typesafe` for a TypeSafe key. On native Windows, Claude Code needs `"command": "cmd"` with `"args": ["/c", "npx", ...]`. Check the setup with `jevpilot-mcp doctor` (the same `npx` command with `doctor` at the end).

The same package is attached to each [GitHub release](https://github.com/bloudhood/jevpilot/releases) as `jevpilot-X.Y.Z.tgz` with `SHA256SUMS.txt`; to install from it, replace `jevpilot@0.4.0` with `https://github.com/bloudhood/jevpilot/releases/download/v0.4.0/jevpilot-0.4.0.tgz`.

## Tools

`browser_run` starts a session toward a goal; `browser_resume` continues it with values, an approval or a new goal. `browser_observe`, `browser_act`, `browser_navigate`, `browser_tabs` and `browser_close` give the agent manual control when it wants it, `browser_screenshot` shows it the page (or one element) as an image or saves it for the user, and `jev_decide` calls Jev directly.

## Documentation

- [Configuration](docs/configuration.md): settings, browser profiles, network safety, HTTP transport, Docker
- [Tools](docs/tools.md): inputs, results and the compatibility policy
- [Privacy](docs/privacy.md): what is sent to Jev at each step
- [Architecture](docs/architecture.md), [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md)

Use jevpilot on sites and accounts you are allowed to automate. It does not solve CAPTCHAs: a detected challenge is handed back.

## License

MIT
