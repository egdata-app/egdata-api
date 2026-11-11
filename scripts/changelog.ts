import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  checkChanges,
  generatedOutputs,
  impact,
  type Assessment,
} from "./changelog/core.js";
import { baseOption, root, snapshot } from "./changelog/io.js";

const [command, ...args] = process.argv.slice(2);

try {
  const head = snapshot();
  if (command === "generate") {
    for (const [p, content] of generatedOutputs(head)) {
      mkdirSync(dirname(resolve(root, p)), { recursive: true });
      writeFileSync(resolve(root, p), content);
    }
    console.log(
      "Generated changelog, manifest, endpoint registry, and documentation histories.",
    );
  } else if (command === "check") {
    const baseCommit = baseOption(args);
    const base = snapshot(baseCommit);
    const { errors } = checkChanges(base, head, baseCommit);
    for (const [p, content] of generatedOutputs(head)) {
      if (head.get(p) !== content) {
        errors.push(
          `Stale generated output: ${p}; run pnpm changelog:generate`,
        );
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("Strict endpoint changelog check passed (read-only).");
  } else if (command === "assess") {
    const baseCommit = baseOption(args);
    const result = impact(snapshot(baseCommit), head);
    const assessment: Assessment = {
      baseCommit,
      diffHash: result.diffHash,
      operations: result.candidates.map((endpoint) => ({
        endpoint,
        impact: "none",
        reason: "TODO: explain concretely why public behavior is preserved",
        records: [],
      })),
      unknownFiles: result.unknown.map((file) => ({
        file,
        reason:
          "TODO: classify this source file and enumerate affected operations",
        endpoints: [],
      })),
    };
    const id = args.includes("--id")
      ? args[args.indexOf("--id") + 1]
      : "current";
    if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error("Assessment ID must be kebab-case");
    }
    const p = resolve(root, "changes/assessments", `${id}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(assessment, null, 2) + "\n");
    console.log(`Wrote ${p}; replace every TODO before checking.`);
  } else if (command === "new") {
    const id = args[0];
    if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(
        "Usage: pnpm changelog:new <unique-kebab-id> <version:operationId> [...operations]",
      );
    }
    const registry = JSON.parse(head.get("changes/endpoints.json") ?? "[]");
    const endpoints = args.slice(1).map((key) => {
      const e = registry.find(
        (e: any) => `${e.apiVersion}:${e.operationId}` === key,
      );
      if (!e) throw new Error(`Unknown endpoint: ${key}`);
      return {
        apiVersion: e.apiVersion,
        operationId: e.operationId,
        method: e.method,
        path: e.path,
        type: "changed",
        compatibility: "compatible",
        before: "TODO: concrete prior behavior",
        after: "TODO: concrete resulting behavior",
        clientAction: "None",
      };
    });
    if (!endpoints.length) throw new Error("Enumerate at least one operation");
    const p = resolve(root, `changes/records/${id}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        {
          id,
          recordedDate: new Date().toISOString().slice(0, 10),
          title: "TODO: describe the public behavior change",
          endpoints,
          verification: ["TODO: relevant test or contract check"],
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    console.log(p);
  } else throw new Error("Expected new, generate, check, or assess");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
