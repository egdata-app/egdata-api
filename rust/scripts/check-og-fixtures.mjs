// Execute canonical Node OG helpers without loading database or renderer clients.
// node rust/scripts/check-og-fixtures.mjs [--write]
import fs from "node:fs";
import ts from "typescript";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
function functions(path, names, dependencies = {}) {
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
    const selected = source.statements.filter((statement) =>
        ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text));
    if (selected.length !== names.length) throw new Error(`Changed source helpers: ${path}`);
    const code = ts.transpileModule(selected.map((statement) => statement.getText(source)).join("\n"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    new Function("exports", ...Object.keys(dependencies), code)(exports, ...Object.values(dependencies));
    return exports;
}
const builds = functions("../../src/utils/builds.ts", ["effectiveBuildPlatform", "buildManifestStatus", "buildSummary"]);
const { latestOgDownload, formatOgSize } = functions("../../src/utils/offer-og.ts", ["latestOgDownload", "formatOgSize"], builds);
const sizes = [null, "100", -1, 0, 0.5, 9_999_999, 10_000_000, 125_000_000, 625_000_000, 1_005_000_000, 1e30]
    .map((input) => ({ input, output: formatOgSize(input) }));
const ogSource = ts.createSourceFile("offer-og.ts", read("../../src/utils/offer-og.ts"), ts.ScriptTarget.Latest, true);
const formatter = ogSource.statements.find((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(ogSource) === "dateFormatter"));
if (!formatter) throw new Error("OG date formatter changed");
const dateFormatter = new Function(`${formatter.getText(ogSource)}; return dateFormatter;`)();
const { formatOgDate } = functions("../../src/utils/offer-og.ts", ["formatOgDate"], { dateFormatter });
const dates = [null, 0, "invalid", "2026-09-01", "2026-09-01T00:00:00Z", "2026-09-01T00:30:00+02:00", "2026-12-31T23:59:59.999Z"]
    .map((input) => ({ input, output: formatOgDate(input) }));

// Extract the actual offer route's price expression, including its /100 conversion.
const route = ts.createSourceFile("og.ts", read("../../src/v1/routes/og.ts"), ts.ScriptTarget.Latest, true);
let priceExpression;
function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(route) === "card" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        const price = node.initializer.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(route) === "price");
        if (price) priceExpression = price.initializer.getText(route);
    }
    ts.forEachChild(node, visit);
}
visit(route);
if (!priceExpression) throw new Error("Offer OG price expression changed");
const price = new Function("amount", "currency", `return (${priceExpression});`);
const currencies = [...new Set([...read("../../src/utils/countries.ts").matchAll(/currencyCode:\s*["']([A-Z]+)["']/g)].map((m) => m[1]))].sort();
if (!currencies.length) throw new Error("No configured region currencies found");
// Exercise ICU's display rules for both current and historical price records.
currencies.push(...("ADP AFN ALL BHD BIF BYR CLF CLP DJF ESP GNF IQD IRR ISK ITL JOD KMF KPW KWD LAK LBP LUF LYD MGA MGF MMK MRO OMR PYG RSD RWF SLL SOS STD SYP TMM TND TRL UGX UYI UYW VUV XAF XCD XCG XOF XPF XXX YER ZMK ZWD").split(" ").filter((code) => !currencies.includes(code)));
const prices = currencies.flatMap((currency) => [500, 550, 199900, 999999].map((amount) => ({ amount, currency, output: price(amount, currency) })));
const priceStates = [
    [null, "?"], ["500", "USD"], [-1, ""], [0, ""], [500, ""], [500, "ÜSD"],
    [500, "uSd"], [100.5, "USD"], [100.499999999, "USD"], [99999.5, "USD"],
    [199.95, "KWD"], [50, "JPY"], [1e-300, "JPY"], [1e30, "USD"], [Number.MAX_VALUE, "CLF"],
].map(([amount, currency]) => {
    try { return { amount, currency, output: price(amount, currency) }; }
    catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return { amount, currency, output: null };
    }
});
const asset = (platform, bytes, extra = {}) => ({ artifactId: "app", platform, downloadSizeBytes: bytes, ...extra });
const build = (extra = {}) => ({ _id: "build", appName: "app", labelName: "Live-Windows", hash: "hash", ...extra });
const downloads = [
    { assets: [] },
    { assets: [asset("Windows", 100), asset("Mac", 200)] },
    { assets: [asset("Windows", 100, { updatedAt: "2026-09-01T00:00:00Z" }), asset("Mac", 200, { updatedAt: "2026-09-02T00:00:00Z" })] },
    { assets: [asset("Windows", 100, { updatedAt: null, createdAt: "2026-09-03T00:00:00Z" }), asset("Mac", 200, { updatedAt: "2026-09-02T00:00:00Z" })] },
    { assets: [asset("Windows", 100, { updatedAt: "invalid" }), asset("Mac", 200, { updatedAt: "invalid" })] },
    { assets: [asset("", 100), asset("Mac", 200)], build: build() },
    { assets: [asset("Windows", 100)], build: build({ platform: "Unknown" }) },
    { assets: [asset("Windows", 100)], build: build({ downloadSizeBytes: 0 }) },
    { assets: [asset("Windows", 100)], build: build({ downloadSizeBytes: null }) },
    { assets: [], build: build() },
    { assets: [asset("Windows", 123)], build: build({ appName: "other", platform: "Unknown" }) },
    { assets: [asset("Mac", 123)], build: build({ platform: "Linux" }) },
    { assets: [asset("Mac", 0.5)], build: build({ platform: "Mac" }) },
    { assets: [asset("Windows", 100, { updatedAt: "2020-01-30" }), asset("Mac", 200, { createdAt: "2026-11-17" })] },
    { assets: [asset("Windows", 100, { updatedAt: 42 }), asset("Mac", 200, { updatedAt: 91 })] },
    { assets: [asset(7, 123, { artifactId: 10 })], build: build({ appName: 10, platform: 7 }) },
    { assets: [asset(false, 123)], build: build({ platform: "Linux" }) },
    { assets: [asset("Linux", 123, { artifactId: { name: "app" } })], build: build({ appName: { name: "app" }, platform: "Linux" }) },
    { assets: [{ platform: "Linux", downloadSizeBytes: 123 }], build: build({ appName: undefined, platform: "Linux" }) },
    { assets: [asset([], 123)] },
].map((input) => ({ ...input, output: latestOgDownload(input.assets, input.build) }));
const output = { prices, priceStates, downloads, dates, sizes };
const destination = new URL("../crates/egdata-api/tests/fixtures/og-node.json", import.meta.url);
if (process.argv.includes("--write")) fs.writeFileSync(destination, JSON.stringify(output, null, 2) + "\n");
else if (JSON.stringify(JSON.parse(fs.readFileSync(destination, "utf8"))) !== JSON.stringify(output)) throw new Error("Stale Node OG fixtures");
console.log(`Validated ${prices.length + priceStates.length} OG prices, ${downloads.length} download selections, ${dates.length} dates and ${sizes.length} sizes against Node`);
