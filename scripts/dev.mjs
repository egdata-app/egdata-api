import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForFile = async (filePath) => {
  while (true) {
    try {
      await access(filePath, constants.F_OK);
      return;
    } catch {
      await sleep(200);
    }
  }
};

const buildWatcher = spawn("pnpm", ["rslib", "build", "--watch"], {
  stdio: "inherit",
  shell: true,
});

buildWatcher.on("exit", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
});

await waitForFile("dist/index.js");

const appRunner = spawn(
  "node",
  [
    "--env-file=.env",
    "--enable-source-maps",
    "-r",
    "@aikidosec/firewall/instrument",
    "--watch-path=./dist",
    "dist/index.js",
  ],
  {
    stdio: "inherit",
    shell: true,
  },
);

appRunner.on("exit", (code) => {
  if (buildWatcher.pid) {
    buildWatcher.kill();
  }
  process.exit(code ?? 0);
});
