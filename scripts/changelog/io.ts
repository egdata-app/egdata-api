import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Snapshot } from "./inventory.js";

export const root = resolve(import.meta.dirname, "../..");

export const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();

const included = (p: string) =>
  /^(src\/|scripts\/|tests\/|openapi\/|changes\/|dashboard\/(worker|tests)\/|dashboard\/(wrangler\.jsonc|package\.json)$|apps\/docs\/content\/|CHANGELOG.md$|package.json$|pnpm-(lock|workspace)\.yaml$|Dockerfile|rslib.config)/.test(
    p,
  );

export function snapshot(ref?: string): Snapshot {
  const paths = ref
    ? git("ls-tree", "-r", "--name-only", ref).split(/\r?\n/)
    : [
        ...new Set([
          ...git("ls-files").split(/\r?\n/),
          ...git("ls-files", "--others", "--exclude-standard").split(/\r?\n/),
        ]),
      ];
  // One git archive stream would be faster but adds a tar parser. Read only relevant tracked sources.
  const files: Snapshot = new Map();
  if (ref) {
    const names = paths.filter(included);
    const objects = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: names.map((p) => `${ref}:${p}`).join("\n") + "\n",
      maxBuffer: 64 * 1024 * 1024,
    });
    let offset = 0;
    for (const path of names) {
      const end = objects.indexOf(10, offset);
      const header = objects.subarray(offset, end).toString();
      const size = Number(header.split(" ")[2]);
      if (!Number.isFinite(size)) throw new Error(`Cannot read ${ref}:${path}`);
      files.set(
        path,
        objects
          .subarray(end + 1, end + 1 + size)
          .toString()
          .replaceAll("\r\n", "\n"),
      );
      offset = end + size + 2;
    }
  } else {
    for (const p of paths.filter(included)) {
      if (existsSync(resolve(root, p))) {
        files.set(
          p,
          readFileSync(resolve(root, p), "utf8").replaceAll("\r\n", "\n"),
        );
      }
    }
  }
  return files;
}

export function baseOption(args: string[]): string {
  const i = args.indexOf("--base");
  const explicit = i >= 0 ? args[i + 1] : process.env.CHANGELOG_BASE;
  if (!explicit) {
    throw new Error(
      "Pass --base <commit-or-ref> locally; CI must supply the actual PR merge base via CHANGELOG_BASE",
    );
  }
  return git("merge-base", explicit, "HEAD");
}
