import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, latestVersion, parseLevel } from "./release";

const RELEASE_SCRIPT_PATH = join(import.meta.dir, "release.ts");
// Isolated from the user's git config (signing, hooks) and identity.
const ISOLATED_GIT_ENVIRONMENT = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(workingDirectory: string, ...gitArguments: string[]): string {
  const { exitCode, stdout, stderr } = Bun.spawnSync(["git", ...gitArguments], {
    cwd: workingDirectory,
    env: ISOLATED_GIT_ENVIRONMENT,
  });
  if (exitCode !== 0) {
    throw new Error(`git ${gitArguments.join(" ")}: ${stderr.toString()}`);
  }
  return stdout.toString().trim();
}

function createEmptyCommit(repositoryPath: string, message: string): void {
  git(repositoryPath, "commit", "--allow-empty", "--message", message);
}

// Working copy on `main` with a bare local `origin`, one pushed commit.
function createRepository() {
  const rootPath = mkdtempSync(join(tmpdir(), "release-test-"));
  temporaryDirectories.push(rootPath);
  const originPath = join(rootPath, "origin.git");
  const workingCopyPath = join(rootPath, "working-copy");
  git(rootPath, "init", "--bare", "--initial-branch", "main", originPath);
  git(rootPath, "init", "--initial-branch", "main", workingCopyPath);
  git(workingCopyPath, "remote", "add", "origin", originPath);
  createEmptyCommit(workingCopyPath, "initial");
  git(workingCopyPath, "push", "origin", "main");
  return { originPath, workingCopyPath };
}

function runRelease(
  workingCopyPath: string,
  commandLineArguments: string[],
  standardInput = "y\n",
) {
  const { exitCode, stdout, stderr } = Bun.spawnSync(
    [process.execPath, RELEASE_SCRIPT_PATH, ...commandLineArguments],
    {
      cwd: workingCopyPath,
      env: ISOLATED_GIT_ENVIRONMENT,
      stdin: Buffer.from(standardInput),
    },
  );
  return { exitCode, output: stdout.toString() + stderr.toString() };
}

function listOriginTags(originPath: string): string[] {
  return git(originPath, "tag", "--list").split("\n").filter(Boolean);
}

function resolveOriginTagCommit(originPath: string, tag: string): string {
  return git(originPath, "rev-parse", `refs/tags/${tag}^{commit}`);
}

// Repository with v1.0.0 and v1 released, then one more pushed commit.
function createReleasedRepository() {
  const repository = createRepository();
  const firstRelease = runRelease(repository.workingCopyPath, ["major"]);
  if (firstRelease.exitCode !== 0) {
    throw new Error(firstRelease.output);
  }
  createEmptyCommit(repository.workingCopyPath, "after release");
  git(repository.workingCopyPath, "push", "origin", "main");
  return repository;
}

// Rejects only the floating tag `v1`, via a per-ref `update` hook.
function rejectFloatingTagOnOrigin(originPath: string) {
  const updateHookPath = join(originPath, "hooks", "update");
  writeFileSync(updateHookPath, '#!/bin/sh\ntest "$1" != refs/tags/v1\n');
  chmodSync(updateHookPath, 0o755);
  return updateHookPath;
}

describe("parseLevel", () => {
  test("defaults to patch", () => {
    const commandLineArguments: string[] = [];

    const level = parseLevel(commandLineArguments);

    expect(level).toBe("patch");
  });

  test.each(["major", "minor", "patch"] as const)("accepts %s", (levelName) => {
    const commandLineArguments = [levelName];

    const level = parseLevel(commandLineArguments);

    expect(level).toBe(levelName);
  });

  test.each([
    [["foo"], /Invalid level 'foo'/],
    [["--tags"], /Invalid level/],
    [["patch", "minor"], /Too many arguments/],
  ])("rejects %p", (commandLineArguments, expectedMessage) => {
    const parseInvalidArguments = () => parseLevel(commandLineArguments);

    expect(parseInvalidArguments).toThrow(expectedMessage);
  });
});

describe("latestVersion", () => {
  test.each([[[]], [[""]]])("starts from 0.0.0 for tags %p", (existingTags) => {
    const highestVersion = latestVersion(existingTags);

    expect(highestVersion).toBe("0.0.0");
  });

  test.each([
    [["v1.9.0", "v1.10.0"], "1.10.0"],
    [["v1.9.0", "v1.10.0", "v1.2.0", "v2.0.0", "v9.9.9", "v10.0.0"], "10.0.0"],
  ])(
    "compares numerically, not lexically: %p",
    (existingTags, expectedVersion) => {
      const highestVersion = latestVersion(existingTags);

      expect(highestVersion).toBe(expectedVersion);
    },
  );

  test.each([
    [["v1", "v2", "v3.0.0-rc1", "v1.2", "4.0.0", "v1.2.3.4", "x"], "0.0.0"],
    [["v1", "v3.0.0-rc1", "v1.2.3"], "1.2.3"],
    [["v1.02.3", "v0.0.1"], "0.0.1"],
  ])(
    "ignores floating, pre-release and non-semver tags: %p",
    (existingTags, expectedVersion) => {
      const highestVersion = latestVersion(existingTags);

      expect(highestVersion).toBe(expectedVersion);
    },
  );
});

describe("buildPlan", () => {
  test.each([
    ["major", { releaseTag: "v1.0.0", floatingTag: "v1" }],
    ["minor", { releaseTag: "v0.1.0", floatingTag: "v0" }],
    ["patch", { releaseTag: "v0.0.1", floatingTag: "v0" }],
  ] as const)("first %s release from no tags", (level, expectedPlan) => {
    const existingTags: string[] = [];

    const plan = buildPlan(existingTags, level);

    expect(plan).toEqual(expectedPlan);
  });

  test.each([
    ["patch", { releaseTag: "v1.10.10", floatingTag: "v1" }],
    ["minor", { releaseTag: "v1.11.0", floatingTag: "v1" }],
    ["major", { releaseTag: "v2.0.0", floatingTag: "v2" }],
  ] as const)("bumps %s of the highest version", (level, expectedPlan) => {
    const existingTags = ["v1", "v1.2.3", "v1.10.9"];

    const plan = buildPlan(existingTags, level);

    expect(plan).toEqual(expectedPlan);
  });

  test("derives a multi-digit floating tag", () => {
    const existingTags = ["v9.4.1"];

    const plan = buildPlan(existingTags, "major");

    expect(plan).toEqual({ releaseTag: "v10.0.0", floatingTag: "v10" });
  });
});

describe("release script", () => {
  test("first major release creates annotated and floating tags", () => {
    const { originPath, workingCopyPath } = createRepository();
    const headCommit = git(workingCopyPath, "rev-parse", "HEAD");

    const { exitCode, output } = runRelease(workingCopyPath, ["major"]);

    expect(exitCode, output).toBe(0);
    expect(listOriginTags(originPath)).toEqual(["v1", "v1.0.0"]);
    expect(git(originPath, "cat-file", "-t", "refs/tags/v1.0.0")).toBe("tag");
    expect(resolveOriginTagCommit(originPath, "v1.0.0")).toBe(headCommit);
    expect(resolveOriginTagCommit(originPath, "v1")).toBe(headCommit);
  });

  test("patch is the default and moves the floating tag", () => {
    const { originPath, workingCopyPath } = createReleasedRepository();
    const headCommit = git(workingCopyPath, "rev-parse", "HEAD");

    const { exitCode, output } = runRelease(workingCopyPath, []);

    expect(exitCode, output).toBe(0);
    expect(listOriginTags(originPath)).toEqual(["v1", "v1.0.0", "v1.0.1"]);
    expect(resolveOriginTagCommit(originPath, "v1")).toBe(headCommit);
    expect(resolveOriginTagCommit(originPath, "v1.0.0")).not.toBe(headCommit);
  });

  test("minor moves the floating tag", () => {
    const { originPath, workingCopyPath } = createReleasedRepository();
    const headCommit = git(workingCopyPath, "rev-parse", "HEAD");

    const { exitCode, output } = runRelease(workingCopyPath, ["minor"]);

    expect(exitCode, output).toBe(0);
    expect(listOriginTags(originPath)).toEqual(["v1", "v1.0.0", "v1.1.0"]);
    expect(resolveOriginTagCommit(originPath, "v1")).toBe(headCommit);
  });

  test("major creates a new floating tag and leaves the old one", () => {
    const { originPath, workingCopyPath } = createReleasedRepository();
    const headCommit = git(workingCopyPath, "rev-parse", "HEAD");
    const oldFloatingTagCommit = resolveOriginTagCommit(originPath, "v1");

    const { exitCode, output } = runRelease(workingCopyPath, ["major"]);

    expect(exitCode, output).toBe(0);
    expect(listOriginTags(originPath)).toEqual([
      "v1",
      "v1.0.0",
      "v2",
      "v2.0.0",
    ]);
    expect(resolveOriginTagCommit(originPath, "v2")).toBe(headCommit);
    expect(resolveOriginTagCommit(originPath, "v1")).toBe(oldFloatingTagCommit);
  });

  test("answering yes creates and pushes the release", () => {
    const { originPath, workingCopyPath } = createRepository();

    const { exitCode, output } = runRelease(workingCopyPath, ["patch"], "y\n");

    expect(exitCode, output).toBe(0);
    expect(output).toMatch(/Release v0\.0\.1\? \[y\/N\]/);
    expect(listOriginTags(originPath)).toEqual(["v0", "v0.0.1"]);
  });

  test("answering no creates and pushes nothing", () => {
    const { originPath, workingCopyPath } = createRepository();

    const { exitCode, output } = runRelease(workingCopyPath, ["major"], "n\n");

    expect(exitCode).toBe(1);
    expect(output).toMatch(/Aborted/);
    expect(listOriginTags(originPath)).toEqual([]);
    expect(git(workingCopyPath, "tag", "--list")).toBe("");
  });

  test("closed standard input creates and pushes nothing", () => {
    const { originPath, workingCopyPath } = createRepository();

    const { exitCode } = runRelease(workingCopyPath, ["major"], "");

    expect(exitCode).toBe(1);
    expect(listOriginTags(originPath)).toEqual([]);
    expect(git(workingCopyPath, "tag", "--list")).toBe("");
  });

  test("aborts on invalid argument", () => {
    const { originPath, workingCopyPath } = createRepository();

    const { exitCode, output } = runRelease(workingCopyPath, ["foo"]);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/Invalid level 'foo'/);
    expect(listOriginTags(originPath)).toEqual([]);
  });

  test("aborts on dirty working tree", () => {
    const { originPath, workingCopyPath } = createRepository();
    writeFileSync(join(workingCopyPath, "untracked"), "x");

    const { exitCode, output } = runRelease(workingCopyPath, ["patch"]);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/Working tree is dirty/);
    expect(listOriginTags(originPath)).toEqual([]);
  });

  test("aborts when not on main", () => {
    const { originPath, workingCopyPath } = createRepository();
    git(workingCopyPath, "checkout", "-b", "feature");

    const { exitCode, output } = runRelease(workingCopyPath, ["patch"]);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/Not on main/);
    expect(listOriginTags(originPath)).toEqual([]);
  });

  test("aborts when behind origin", () => {
    const { originPath, workingCopyPath } = createRepository();
    createEmptyCommit(workingCopyPath, "newer");
    git(workingCopyPath, "push", "origin", "main");
    git(workingCopyPath, "reset", "--hard", "HEAD~1");

    const { exitCode, output } = runRelease(workingCopyPath, ["patch"]);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/differs from origin\/main/);
    expect(listOriginTags(originPath)).toEqual([]);
  });

  test("aborts when ahead of origin", () => {
    const { originPath, workingCopyPath } = createRepository();
    createEmptyCommit(workingCopyPath, "unpushed");

    const { exitCode, output } = runRelease(workingCopyPath, ["patch"]);

    expect(exitCode).toBe(1);
    expect(output).toMatch(/differs from origin\/main/);
    expect(listOriginTags(originPath)).toEqual([]);
  });

  describe("with another clone pushing to origin", () => {
    function createRepositoryWithPushFromAnotherClone() {
      const repository = createRepository();
      const otherClonePath = join(repository.workingCopyPath, "..", "other");
      git(
        repository.workingCopyPath,
        "clone",
        repository.originPath,
        otherClonePath,
      );
      createEmptyCommit(otherClonePath, "from another clone");
      git(otherClonePath, "push", "origin", "main");
      git(otherClonePath, "tag", "--annotate", "--message", "v5.0.0", "v5.0.0");
      git(otherClonePath, "push", "origin", "v5.0.0");
      return repository;
    }

    test("aborts when origin/main is ahead of the working copy", () => {
      const { originPath, workingCopyPath } =
        createRepositoryWithPushFromAnotherClone();

      const { exitCode, output } = runRelease(workingCopyPath, ["patch"]);

      expect(exitCode).toBe(1);
      expect(output).toMatch(/differs from origin\/main/);
      expect(listOriginTags(originPath)).toEqual(["v5.0.0"]);
    });

    test("offers the next version after pulling", () => {
      const { originPath, workingCopyPath } =
        createRepositoryWithPushFromAnotherClone();
      git(workingCopyPath, "pull", "--ff-only", "origin", "main");

      const { exitCode, output } = runRelease(workingCopyPath, ["patch"]);

      expect(exitCode, output).toBe(0);
      expect(output).toMatch(/Tag v5\.0\.1 and move v5 on/);
      expect(listOriginTags(originPath)).toEqual(["v5", "v5.0.0", "v5.0.1"]);
    });
  });

  describe("when origin rejects the floating tag", () => {
    test("push is atomic and the local release tag is removed", () => {
      const { originPath, workingCopyPath } = createRepository();
      rejectFloatingTagOnOrigin(originPath);

      const { exitCode, output } = runRelease(workingCopyPath, ["major"]);

      expect(exitCode).toBe(1);
      expect(output).toMatch(/Release v1\.0\.0 failed/);
      expect(listOriginTags(originPath)).toEqual([]);
      expect(git(workingCopyPath, "tag", "--list", "v1.0.0")).toBe("");
    });

    test("a rerun offers the same version", () => {
      const { originPath, workingCopyPath } = createRepository();
      const updateHookPath = rejectFloatingTagOnOrigin(originPath);
      runRelease(workingCopyPath, ["major"]);
      rmSync(updateHookPath);

      const { exitCode, output } = runRelease(workingCopyPath, ["major"]);

      expect(exitCode, output).toBe(0);
      expect(output).toMatch(/Tag v1\.0\.0 and move v1/);
      expect(listOriginTags(originPath)).toEqual(["v1", "v1.0.0"]);
    });
  });

  test("succeeds with tag.gpgsign=true", () => {
    const { originPath, workingCopyPath } = createRepository();
    const fakeGpgProgramPath = join(workingCopyPath, "..", "fake-gpg");
    writeFileSync(
      fakeGpgProgramPath,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        'echo "[GNUPG:] SIG_CREATED D 1 8 00 0 X" >&2',
        "echo '-----BEGIN PGP SIGNATURE-----'",
        "echo fake",
        "echo '-----END PGP SIGNATURE-----'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGpgProgramPath, 0o755);
    git(workingCopyPath, "config", "gpg.program", fakeGpgProgramPath);
    git(workingCopyPath, "config", "tag.gpgsign", "true");
    git(workingCopyPath, "config", "user.signingkey", "FAKE");

    const { exitCode, output } = runRelease(workingCopyPath, ["major"]);

    expect(exitCode, output).toBe(0);
    expect(listOriginTags(originPath)).toEqual(["v1", "v1.0.0"]);
  });
});
