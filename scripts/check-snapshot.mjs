#!/usr/bin/env node
// Checks whether upstream OpenArchiver has published a newer OSS dev snapshot than the
// one pinned for the Integration matrix, and (with --write) re-pins it.
//
// The matrix carries one commit-SHA tag as an early warning for breaking changes ahead
// of a release. That pin is a fixed commit, so it silently goes stale -- this is what the
// scheduled `Snapshot check` workflow runs to catch that.
//
// Snapshot tags are the 7-hex-char commit tags on Docker Hub. Semver tags (v0.5.2) are
// releases and belong in the blocking matrix legs, not here; `-enterprise` images need a
// license and are skipped.
//
// Exit code is always 0 for "worked"; the outcome is reported on stdout and, under
// Actions, written to $GITHUB_OUTPUT as changed/current/latest/label.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

// The pin lives in a plain data file, not in the workflow: GitHub rejects every
// GITHUB_TOKEN push that touches .github/workflows/**, so a bot cannot re-pin there.
const PIN_FILE = ".github/oa-snapshot.json";
const TAGS_URL =
  "https://hub.docker.com/v2/repositories/logiclabshq/open-archiver/tags?page_size=100&ordering=last_updated";
const UPSTREAM_REPO = "LogicLabs-OU/OpenArchiver";
const SNAPSHOT_RE = /^[0-9a-f]{7,40}$/;

const write = process.argv.includes("--write");

function output(pairs) {
  console.log(
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(pairs)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n"
    );
  }
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

const res = await fetch(TAGS_URL);
if (!res.ok) throw new Error(`Docker Hub tag listing failed (${res.status})`);
const { results } = await res.json();

const snapshots = results
  .filter((t) => SNAPSHOT_RE.test(t.name) && !t.name.endsWith("-enterprise"))
  .sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated));
if (snapshots.length === 0) throw new Error("no OSS snapshot tags found on Docker Hub");
const latest = snapshots[0];

const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
const pinned = pin.snapshot;
if (!SNAPSHOT_RE.test(pinned ?? "")) {
  throw new Error(`${PIN_FILE} has no valid "snapshot" commit tag (found: ${pinned})`);
}

if (latest.name === pinned) {
  output({ changed: "false", current: pinned, latest: latest.name });
  console.log(`Snapshot pin ${pinned} is current (pushed ${latest.last_updated.slice(0, 10)}).`);
  process.exit(0);
}

// Only move forward: a tag list reordering must never re-pin an older snapshot.
const pinnedTag = results.find((t) => t.name === pinned);
if (pinnedTag && new Date(latest.last_updated) <= new Date(pinnedTag.last_updated)) {
  output({ changed: "false", current: pinned, latest: latest.name });
  console.log(`Newest snapshot ${latest.name} is not newer than the pinned ${pinned}; ignoring.`);
  process.exit(0);
}

const date = latest.last_updated.slice(0, 10);
const label = (await commitLabel(latest.name)) ?? "dev";
output({ changed: "true", current: pinned, latest: latest.name, label, date });
console.log(`New snapshot: ${pinned} -> ${latest.name} ("${label}", pushed ${date}).`);

if (!write) process.exit(0);

// Rewrite only the three pin fields, so any other key (and the key order) survives.
writeFileSync(PIN_FILE, `${JSON.stringify({ ...pin, snapshot: latest.name, label, date }, null, 2)}\n`);
console.log(`Re-pinned ${PIN_FILE}.`);
