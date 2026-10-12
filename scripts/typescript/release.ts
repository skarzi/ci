// Usage: bun scripts/typescript/release.ts [major|minor|patch]
//
// Tags HEAD of `main` as `vX.Y.Z` (annotated), force-moves the floating major
// tag `vX` to it and pushes both. Current version = highest semver git tag.
import semver from "semver";

export const LEVELS = ["major", "minor", "patch"] as const;
export type Level = (typeof LEVELS)[number];

const INITIAL_VERSION = "0.0.0";
const RELEASE_REMOTE = "origin";
const RELEASE_BRANCH = "main";

export function parseLevel(commandLineArguments: string[]): Level {
  if (commandLineArguments.length > 1) {
    throw new Error(`Too many arguments: ${commandLineArguments.join(" ")}.`);
  }
  const requestedLevel = commandLineArguments[0] ?? "patch";
  const supportedLevel = LEVELS.find((level) => level === requestedLevel);
  if (supportedLevel === undefined) {
    throw new Error(
      `Invalid level '${requestedLevel}'. Use ${LEVELS.join(", ")}.`,
    );
  }
  return supportedLevel;
}

export function latestVersion(existingTags: string[]): string {
  const releaseVersions = existingTags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => tag.slice(1))
    .filter((version) => semver.valid(version) === version);
  return semver.rsort(releaseVersions)[0] ?? INITIAL_VERSION;
}

export function buildPlan(existingTags: string[], level: Level) {
  // NOTE: The next version is above every existing tag, so it cannot exist.
  // `git tag` and `git push` (without `--force`) refuse a duplicate anyway.
  const nextVersion = semver.inc(latestVersion(existingTags), level);
  if (nextVersion === null) {
    throw new Error(`Cannot bump ${level}.`);
  }
  return {
    releaseTag: `v${nextVersion}`,
    floatingTag: `v${semver.major(nextVersion)}`,
  };
}

// Never throws on a failing git command, the caller decides what to do.
function runGit(...gitArguments: string[]) {
  const { exitCode, stdout } = Bun.spawnSync(["git", ...gitArguments], {
    stderr: "inherit",
  });
  return { exitCode, output: stdout.toString().trim() };
}

function git(...gitArguments: string[]): string {
  const { exitCode, output } = runGit(...gitArguments);
  if (exitCode !== 0) {
    throw new Error(`'git ${gitArguments.join(" ")}' failed.`);
  }
  return output;
}

function assertIsReleasable(): void {
  if (git("status", "--porcelain") !== "") {
    throw new Error("Working tree is dirty.");
  }
  if (git("branch", "--show-current") !== RELEASE_BRANCH) {
    throw new Error(`Not on ${RELEASE_BRANCH}.`);
  }
  git("fetch", "--quiet", "--force", "--tags", RELEASE_REMOTE, RELEASE_BRANCH);
  const remoteBranch = `${RELEASE_REMOTE}/${RELEASE_BRANCH}`;
  if (git("rev-parse", "HEAD") !== git("rev-parse", remoteBranch)) {
    throw new Error(`HEAD differs from ${remoteBranch} (behind or ahead).`);
  }
}

export function main(commandLineArguments: string[]): void {
  const level = parseLevel(commandLineArguments);
  assertIsReleasable();
  const existingTags = git("tag", "--list").split("\n");
  const { releaseTag, floatingTag } = buildPlan(existingTags, level);
  const headCommit = git("rev-parse", "--short", "HEAD");
  console.log(`Tag ${releaseTag} and move ${floatingTag} on ${headCommit}.`);
  if (!confirm(`Release ${releaseTag}?`)) {
    throw new Error("Aborted.");
  }
  try {
    git("tag", "--annotate", "--message", releaseTag, releaseTag);
    git("tag", "--no-sign", "--force", floatingTag);
    // Atomic, and `+` forces only the floating tag, never the release tag.
    git(
      "push",
      "--atomic",
      RELEASE_REMOTE,
      `refs/tags/${releaseTag}`,
      `+refs/tags/${floatingTag}`,
    );
  } catch (error) {
    // `runGit`, not `git`: a throw here would mask the original error.
    // A stale local floating tag is reset by `fetch --force --tags` next run.
    runGit("tag", "--delete", releaseTag);
    throw new Error(
      `Release ${releaseTag} failed, local tag removed: ${error}`,
    );
  }
  console.log(`Released ${releaseTag}, moved ${floatingTag}.`);
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
