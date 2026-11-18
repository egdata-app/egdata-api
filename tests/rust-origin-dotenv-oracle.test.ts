import { parse } from "dotenv";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { envFileArgs } from "../rust/scripts/env-file.mjs";

it("captures the Node origin's dotenv parsing with synthetic credentials", () => {
  const inputs = {
    credentials: [
      "NAME=fixture",
      'OPENSEARCH_PASSWORD="pre$NAME:${NAME} #suffix"',
      "REDISPASSWORD='\\$test#@&='",
      "MONGO_URL=mongodb://local/?authMechanism=MONGODB-X509&authSource=$external",
      "BETTER_AUTH_SECRET=`just a ${literal}`",
    ].join("\n"),
    assignments: "\uFEFFexport A=first\rA=last\r\nB:  colon assignment\nempty=\nspaced.key-1 = value  # comment\nignored line\n__proto__=value\n",
    quoted: "ONE='raw\\n\\r'\nTWO=\"expanded\\n\\r\"\nTHREE=`back\\n`\nFOUR='multi\nline#data'\n",
    comments: "EMPTY=#blank\nHASH=left#right\nQUOTED=\"with#hash\"  # comment\nSINGLE='\"inner\"'\n",
    escaping: String.raw`DOUBLE="a\"b\\c"\nSINGLE='d\'e'\nUNKNOWN="\t\q"`.replaceAll("\\n", "\n"),
    malformed: "valid=before\ninvalid=\u0085\nA='unclosed\nB=next\njust a line\nexport\tAFTER=ok",
    utf8: Buffer.from([0x58, 0x3d, 0xff, 0x0a]),
  };
  assertOracle("origin-dotenv-node", Object.entries(inputs).map(([name, input]) => {
    const bytes = Buffer.from(input);
    return { name, hex: bytes.toString("hex"), parsed: parse(bytes) };
  }));
});

it("resolves local server and admin CLI dotenv paths before entering the Rust workspace", () => {
  const existing = resolve("package.json");
  const selected = resolve("fixtures/test.env");
  expect(envFileArgs(["--port", "0"], existing)).toEqual(["--env-file", existing, "--port", "0"]);
  expect(envFileArgs([], existing + ".absent")).toEqual([]);
  expect(envFileArgs(["--env-file", "fixtures/test.env", "ensure-v1-indexes"], existing))
    .toEqual(["--env-file", selected, "ensure-v1-indexes"]);
  expect(envFileArgs(["--env-file=fixtures/test.env"], existing)).toEqual(["--env-file=" + selected]);
  expect(envFileArgs(["--env-file"], existing)).toEqual(["--env-file"]);
  expect(envFileArgs(["--env-file", "--port", "4001"], existing)).toEqual(["--env-file", "--port", "4001"]);
});
