# Contributing

## Setup

Use Node.js 22 or newer. Install the locked dependencies:

```sh
npm ci
```

Build the distributable:

```sh
npm run build
```

## Checks

Run the checks relevant to your change before opening a pull request:

```sh
npm run format
npm run typecheck
npm run test:unit
npm run test:integration
node scripts/docker-test.mjs
```

Unit tests use fake browser/decision dependencies and local fixtures. They must not access the public network or a contributor's browser profile, home directory or other personal folders.

Integration tests start local fixture servers and use a real browser or the Docker server profile. They do not require public test sites. If a test starts a server, put every await after server startup inside try/finally so cleanup runs when setup or assertions fail.

Integration tests that pass extraArgs must merge testProfile().extraArgs rather than replacing the profile's required flags. Use the shared test profile helper in test/support/browser-profile.ts.

Docker tests require Docker and may need network access to download base images and OS packages. The script builds the test and runtime images, runs tests under Xvfb and headless profiles, then checks the runtime MCP tools and HTTP transport.

The architecture boundaries are enforced by test/engine/architecture.test.ts, test/orchestrator/architecture.test.ts and test/mcp/architecture.test.ts. Run the full unit suite when changing imports or shared interfaces.

## Proposing a change

Open an issue or pull request with the user problem, proposed behavior, compatibility impact and tests. Keep changes focused. Add tests at the layer that owns the behavior. Document user-visible configuration and tool changes.

## License

Contributions are accepted under the MIT license used by this repository. By submitting a contribution, you agree that it may be distributed under that license.
