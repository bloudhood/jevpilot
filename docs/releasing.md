# Releasing

This checklist prepares a GitHub Release (vX.Y.Z). The release assets are the npm pack tarball and its SHA256SUMS.txt checksum file. The same tarball is published to npm once the maintainer explicitly approves publishing this release; no Docker image is published.

1. Update the package version and lockfile version. Replace the unreleased date in CHANGELOG.md with the release date and review the user-visible entries.
2. Update the version in the install commands of README.md, README.zh-CN.md and docs/configuration.md, both `jevpilot@X.Y.Z` and the release URL. Commit these changes; the tag in step 8 must point at this commit.
3. From a clean checkout, install dependencies and run:

   ```sh
   npm ci
   npm run format:check
   npm run typecheck
   npm run test:unit
   npm run test:integration
   node scripts/docker-test.mjs
   ```

   Integration tests need the supported browser environment or Docker server profile. The Docker script needs Docker and access to download its build inputs.

4. Run the package smoke test:

   ```sh
   node scripts/pack-smoke.mjs
   ```

   It builds and packs the package, checks that it contains only package.json, the READMEs, LICENSE and dist/, installs it into a temporary project, and starts the MCP server both from the installed CLI and with the README's `npx --package` command. It installs and runs from `.npm-cache` without network access and fails if a required dependency is missing from that cache.

5. Create the release tarball:

   ```sh
   npm pack
   ```

   Confirm the resulting file is jevpilot-X.Y.Z.tgz and inspect its contents.

6. Create SHA256SUMS.txt in the directory containing the tarball.

   Linux:

   ```sh
   sha256sum jevpilot-X.Y.Z.tgz > SHA256SUMS.txt
   sha256sum -c SHA256SUMS.txt
   ```

   PowerShell:

   ```powershell
   $hash = (Get-FileHash .\jevpilot-X.Y.Z.tgz -Algorithm SHA256).Hash.ToLowerInvariant()
   "$hash  jevpilot-X.Y.Z.tgz" | Set-Content -Encoding ascii SHA256SUMS.txt
   $expected = ((Get-Content .\SHA256SUMS.txt) -split '\s+')[0]
   if ((Get-FileHash .\jevpilot-X.Y.Z.tgz -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA256 mismatch' }
   ```

7. After the maintainer explicitly approves publishing this release, publish the exact tarball so the npm package and GitHub asset are byte-identical:

   ```sh
   npm publish jevpilot-X.Y.Z.tgz
   npm view jevpilot@X.Y.Z dist.shasum   # must equal: sha1 of jevpilot-X.Y.Z.tgz
   ```

   PowerShell SHA-1 check:

   ```powershell
   $sha1 = (Get-FileHash .\jevpilot-X.Y.Z.tgz -Algorithm SHA1).Hash.ToLowerInvariant()
   $npmSha1 = (npm view jevpilot@X.Y.Z dist.shasum).Trim()
   if ($sha1 -ne $npmSha1) { throw 'SHA1 mismatch' }
   ```

   The README must not reach the public repository before `jevpilot@X.Y.Z` exists on npm: publish first, then push the release commit and tag.

8. Create the annotated tag on the release commit:

   ```sh
   git tag -a vX.Y.Z -m "jevpilot vX.Y.Z"
   ```

9. Create a GitHub Release for that tag. Attach both jevpilot-X.Y.Z.tgz and SHA256SUMS.txt. Download the tarball from the release URL used in the README and check it against SHA256SUMS.txt.

10. With `JEV_PROVIDER` and `JEV_API_KEY` set, run the documented command from an empty npm cache and expect 0 failures:

    ```sh
    npx -y --cache "$(mktemp -d)" --package jevpilot@X.Y.Z jevpilot-mcp doctor
    ```
