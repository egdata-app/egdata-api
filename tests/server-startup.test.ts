import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the real boot function without importing route modules that connect
// to external services at module load. A stalled index build models the outage
// on a populated production database; no MongoDB server is needed for this test.
function bootHarness() {
  const source = readFileSync("src/index.ts", "utf8");
  const ast = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const boot = ast.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "startServer",
  );
  if (!boot) throw new Error("HTTP boot function missing");
  const httpServer = { on: vi.fn() };
  const env = {
    db: { connect: vi.fn(async () => {}), db: {} },
    ensureCatalogHydrationIndexes: vi.fn(async () => {}),
    ensureV1Indexes: vi.fn(() => new Promise(() => {})),
    app: { fetch: vi.fn() },
    serve: vi.fn(() => httpServer),
    installShutdownHandlers: vi.fn(),
    console: { error: vi.fn() },
    process: { exit: vi.fn() },
  };
  const start = runInNewContext(
    ts.transpileModule(`${boot.getText(ast)}\nstartServer;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    env,
  ) as () => Promise<void>;
  return { env, start, httpServer };
}

describe("HTTP startup", () => {
  it("opens HTTP without running or awaiting v1 index provisioning", async () => {
    const { env, start, httpServer } = bootHarness();
    const started = start();
    await setImmediate();
    expect(env.serve).toHaveBeenCalledWith({
      fetch: env.app.fetch,
      port: 4000,
    });
    expect(env.ensureV1Indexes).not.toHaveBeenCalled();
    expect(env.installShutdownHandlers).toHaveBeenCalledWith(httpServer);
    await started;
  });

  it("still requires a successful database connection before serving requests", async () => {
    const { env, start } = bootHarness();
    env.db.connect.mockRejectedValueOnce(new Error("Database unavailable"));
    await start();
    expect(env.serve).not.toHaveBeenCalled();
    expect(env.process.exit).toHaveBeenCalledWith(1);
  });
});
