#!/usr/bin/env node
// Checks whether upstream OpenArchiver has published images newer than the ones pinned for
// the Integration matrix in .github/oa-snapshot.json, and (with --write) re-pins them.
//
// Two kinds of pins live there, and both go stale silently because they are fixed tags:
//   - `snapshot`: one commit-SHA tag (7+ hex chars), a non-blocking early warning for
//     breaking changes on upstream main ahead of a release.
//   - `releases`: the two newest OSS semver tags (vX.Y.Z), the blocking matrix legs.
// This is what the scheduled `Snapshot check` workflow runs to catch both.
//
// `-enterprise` images need a license and are skipped; other tag names (`latest`, ad-hoc
// branch builds) match neither pattern and are ignored.
//
// Exit code is always 0 for "worked"; the outcome is reported on stdout and, under
// Actions, written to $GITHUB_OUTPUT (changed, branch, title, tags) plus a Markdown table
// of the changes to $RUNNER_TEMP/oa-changes.md for the PR body.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// The pins live in a plain data file, not in the workflow: GitHub rejects every
// GITHUB_TOKEN push that touches .github/workflows/**, so a bot cannot re-pin there.
const PIN_FILE = ".github/oa-snapshot.json";
const TAGS_URL =
  "https://hub.docker.com/v2/repositories/logiclabshq/open-archiver/tags?page_size=100&ordering=last_updated";
const UPSTREAM_REPO = "LogicLabs-OU/OpenArchiver";
const SNAPSHOT_RE = /^[0-9a-f]{7,40}$/;
const RELEASE_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_COUNT = 2; // current release + the one before it

const write = process.argv.includes("--write");

function output(pairs) {
  const text = Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  console.log(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text + "\n");
}

// The commit subject ("V0.5.3 dev") is only a human-readable label in the pin file and
// in the PR body, so a failed lookup must not fail the check.
async function commitLabel(sha) {
  try {
    const headers = { accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/${sha}`, {
      headers,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.commit?.message?.split("\n")[0]?.replace(/\s*\(#\d+\)\s*$/, "") ?? null;
  } catch {
    return null;
  }
}

function semver(tag) {
  const m = RELEASE_RE.exec(tag);
  return m ? m.slice(1).map(Number) : null;
}

function compareSemver(a, b) {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const res = await fetch(TAGS_URL);
if (!res.ok) throw new Error(`Docker Hub tag listing failed (${res.status})`);
const { results } = await res.json();

const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
if (!SNAPSHOT_RE.test(pin.snapshot ?? "")) {
  throw new Error(`${PIN_FILE} has no valid "snapshot" commit tag (found: ${pin.snapshot})`);
}
if (!Array.isArray(pin.releases) || !pin.releases.every((r) => RELEASE_RE.test(r))) {
  throw new Error(`${PIN_FILE} has no valid "releases" list (found: ${JSON.stringify(pin.releases)})`);
}

const next = { ...pin };
const changes = []; // Markdown table rows for the PR body
const tags = []; // newly pinned tags the workflow should verify

// --- snapshot -------------------------------------------------------------------------
const snapshots = results
  .filter((t) => SNAPSHOT_RE.test(t.name))
  .sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated));
if (snapshots.length === 0) throw new Error("no OSS snapshot tags found on Docker Hub");
const latest = snapshots[0];
const pinnedTag = results.find((t) => t.name === pin.snapshot);

if (latest.name === pin.snapshot) {
  console.log(`Snapshot pin ${pin.snapshot} is current.`);
} else if (pinnedTag && new Date(latest.last_updated) <= new Date(pinnedTag.last_updated)) {
  // Only move forward: a tag list reordering must never re-pin an older snapshot.
  console.log(`Newest snapshot ${latest.name} is not newer than the pinned ${pin.snapshot}; ignoring.`);
} else {
  const date = latest.last_updated.slice(0, 10);
  const label = (await commitLabel(latest.name)) ?? "dev";
  Object.assign(next, { snapshot: latest.name, label, date });
  changes.push(`| Snapshot | \`${pin.snapshot}\` | \`${latest.name}\` (pushed ${date}: ${label}) |`);
  tags.push(latest.name);
  console.log(`New snapshot: ${pin.snapshot} -> ${latest.name} ("${label}", pushed ${date}).`);
}

// --- releases -------------------------------------------------------------------------
// Merge with the pinned list, so a release that dropped off the (recency-ordered) first
// page of the tag listing can never push the pin backwards.
const releases = [...new Set([...results.map((t) => t.name).filter((n) => RELEASE_RE.test(n)), ...pin.releases])]
  .sort((a, b) => compareSemver(b, a))
  .slice(0, RELEASE_COUNT);

if (releases.join() === pin.releases.join()) {
  console.log(`Release pins ${pin.releases.join(", ")} are current.`);
} else {
  next.releases = releases;
  changes.push(`| Releases | ${pin.releases.map((r) => `\`${r}\``).join(", ")} | ${releases.map((r) => `\`${r}\``).join(", ")} |`);
  tags.push(...releases.filter((r) => !pin.releases.includes(r)));
  console.log(`New releases: ${pin.releases.join(", ")} -> ${releases.join(", ")}.`);
}

if (changes.length === 0) {
  output({ changed: "false" });
  process.exit(0);
}

// Tag names are validated against SNAPSHOT_RE / RELEASE_RE above, so they are safe to use
// in a branch name and a space-separated list.
const title = `ci: re-pin OpenArchiver ${tags.join(", ")}`;
output({
  changed: "true",
  branch: `ci/oa-pin-${[next.snapshot, ...next.releases].join("-")}`,
  title,
  tags: tags.join(" "),
});

if (process.env.RUNNER_TEMP) {
  writeFileSync(
    join(process.env.RUNNER_TEMP, "oa-changes.md"),
    ["| | Current pin | New pin |", "|---|---|---|", ...changes].join("\n") + "\n"
  );
}

if (!write) process.exit(0);

// Rewrite only the pin fields, so any other key (and the key order) survives.
writeFileSync(PIN_FILE, `${JSON.stringify(next, null, 2)}\n`);
console.log(`Re-pinned ${PIN_FILE}.`);
