// Select only this run's newly created npx installs; other processes share the cache.
export function selectOwnNpxInstalls(entries, before, tarball) {
  return entries
    .filter(
      ({ name, packageJson }) =>
        !before.has(name) && packageJson?._npx?.packages?.includes(tarball),
    )
    .map(({ name }) => name);
}
