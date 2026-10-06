import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The runnable pack script helper is JavaScript.
import { selectOwnNpxInstalls } from "../../scripts/pack-smoke-cleanup.mjs";

test("pack smoke removes only its own npx install", () => {
  const tarball = "C:/temp/jevpilot-run/jevpilot.tgz";
  const own = { _npx: { packages: [tarball] } };
  assert.deepEqual(
    selectOwnNpxInstalls(
      [
        { name: "own-new", packageJson: own },
        { name: "other-new", packageJson: { _npx: { packages: ["C:/temp/other.tgz"] } } },
        { name: "own-old", packageJson: own },
        { name: "missing", packageJson: undefined },
      ],
      new Set(["own-old"]),
      tarball,
    ),
    ["own-new"],
  );
});
