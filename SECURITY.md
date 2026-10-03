# Security policy

## Supported versions

Security fixes are provided for the 0.2.x release line.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository from its Security tab. Do not open a public issue for an unpatched vulnerability. There is no security-reporting email address.

## Security model

- The network guard defaults to metadata mode. It blocks cloud metadata addresses for document navigations, frames, redirects, popups and downloads. Private mode also blocks loopback and private ranges; off disables built-in ranges. Only private mode refuses unverified hosts (lookup timeouts or resolver errors other than `ENOTFOUND`/`ENODATA`), and only when the browser resolves names itself; behind a configured proxy the proxy resolves them. Metadata mode and off with extra blocked ranges allow them, relying on the connected-IP check where it applies. Subresource requests are not checked.
- Resolver rules containing spaces belong in an `extraArgs` entry in a `JEVPILOT_PROFILE_FILE` JSON profile, for example `"--host-resolver-rules=MAP *.internal.test 169.254.169.254"`; the guard applies these rules to its lookup. `JEVPILOT_EXTRA_ARGS` splits on whitespace and cannot preserve such rules.
- Known limits: Node also reports `ENOTFOUND` for some resolver failures (for example no free file descriptors); these hosts are treated as missing. With a browser proxy configured, the connected-IP check is skipped, so requests that bypass it (bypass lists or PAC `DIRECT`) are checked only by the local lookup. Because the browser resolves a name again when connecting, DNS rebinding between the guard lookup and the connection is caught only by the connected-IP check after the response, and not where that check is skipped. The download check runs as a download starts; a very small file may finish before rejection cancels it.
- Streamable HTTP binds to 127.0.0.1 by default and always requires a bearer token of at least 16 characters. Origin and Host checks protect requests; there is no built-in TLS. Put non-loopback deployments behind a TLS reverse proxy.
- Secret references may read only environment variables whose names begin with JEVPILOT_SECRET_ or files beneath JEVPILOT_SECRETS_DIR. File paths are resolved and checked against that root. Password values and resolved secret literals are redacted from observations and results.
- File uploads are limited to files beneath JEVPILOT_UPLOAD_DIR.
- Server and per-session domain allowlists constrain browser navigation. The network guard additionally protects against metadata-address access. These checks do not control page subresources.
- There is no MCP tool for evaluating arbitrary JavaScript in the page.
- Decision API keys and HTTP tokens are not written to decision logs or returned in tool results. Decision API keys are sent as bearer authorization to the configured decision endpoint.
- Challenges and CAPTCHAs are detected and handed back. jevpilot does not solve them.

See docs/privacy.md for the data sent to Jev, browser destinations and local storage.
