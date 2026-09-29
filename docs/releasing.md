# Releasing

This checklist prepares the v0.1.0 GitHub Release. The release assets are the npm pack tarball and its SHA256SUMS.txt checksum file. Do not publish the package to the npm registry or a Docker image as part of this release.

1. Update the package version and lockfile version. Replace the unreleased date in CHANGELOG.md with the release date and review the user-visible entries.
2. Update the version in the README install URLs (`releases/download/vX.Y.Z/jevpilot-X.Y.Z.tgz`). Commit these changes; the tag in step 7 must point at this commit.
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

   It builds and packs the package, installs it into a temporary project and checks the installed MCP command.

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

7. Create the annotated tag on the release commit:

   ```sh
   git tag -a vX.Y.Z -m "jevpilot vX.Y.Z"
   ```

8. Create a GitHub Release for that tag. Attach both jevpilot-X.Y.Z.tgz and SHA256SUMS.txt. Download the tarball from the release URL used in the README and check it against SHA256SUMS.txt.
