import { Hono } from "hono";
import { BSON, MongoClient, ObjectId } from "mongodb";
import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
const { maybeAddIdToDocuments } = createRequire(import.meta.url)(
  "mongodb/lib/utils",
);
const userCollection = new MongoClient("mongodb://127.0.0.1:1", {
  pkFactory: { createPk: () => new ObjectId("000000000000000000000011") },
})
  .db("fixture")
  .collection("users");
import { afterAll, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";

type RequestCase = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
};
type Setup = {
  rows?: readonly unknown[];
  role?: string;
  session?: boolean;
  docs?: Record<string, unknown>;
  discord?: unknown;
  epic?: unknown;
  disappear?: boolean;
  delivery?: "expired" | "failed" | "unnamed";
  fault?: string;
  deleted?: number;
  tokenStatus?: number;
  afterFirstReviewUpdate?: { current: unknown };
};
vi.hoisted(() => vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-google-client"));
const key = readFileSync(
  new URL("../rust/oracles/account-fixture-rsa-private.pem", import.meta.url),
  "utf8",
);
const googleJwk = {
  ...createPublicKey(key).export({ format: "jwk" }),
  kid: "fixture-key",
  use: "sig",
  alg: "RS256",
};
const googleJwt = jwt.sign(
  {
    sub: "fixture-user",
    iss: "accounts.google.com",
    aud: "fixture-google-client",
    email: "fixture@fixture.invalid",
    exp: 4102444800,
  },
  key,
  { algorithm: "RS256", keyid: "fixture-key", noTimestamp: true },
);
const io = vi.hoisted(() => ({
  setup: {} as Setup,
  trace: [] as unknown[],
  deliveries: [] as unknown[],
  http: [] as unknown[],
}));
function encoded(value: unknown): unknown {
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encoded);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, encoded(v)]),
    );
  return value;
}
function mongo(
  collection: string,
  method: string,
  query: unknown,
  options: unknown,
  result: unknown,
) {
  const call = encoded({ collection, method, query, options });
  if (io.setup.fault === collection + "." + method) {
    io.trace.push({ call, error: true });
    throw new Error("fixture read failed");
  }
  io.trace.push({ call, result: encoded(result) });
  return result;
}
vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (collection: string) => ({
        findOne: async (filter: unknown, options = {}) =>
          mongo(
            collection,
            "one",
            filter,
            options,
            collection === "epic"
              ? { accountId: "fixture-account", role: io.setup.role ?? "admin" }
              : collection in (io.setup.docs ?? {})
                ? io.setup.docs?.[collection]
                : collection === "users" &&
                    io.setup.disappear &&
                    !("projection" in options && options.projection)
                  ? null
                  : (io.setup.rows?.[0] ?? null),
          ),
        find: (filter: unknown, options = {}) => ({
          toArray: async () =>
            mongo(collection, "many", filter, options, io.setup.rows ?? []),
        }),
        aggregate: (pipeline: unknown) => ({
          toArray: async () =>
            mongo(collection, "aggregate", pipeline, {}, io.setup.rows ?? []),
        }),
        insertOne: async (row: unknown) => {
          if (collection === "users")
            maybeAddIdToDocuments(userCollection, row, {});
          return mongo(collection, "insert", row, {}, { acknowledged: true });
        },
        updateOne: async (filter: unknown, update: unknown) => {
          if (collection === "reviews" && io.setup.afterFirstReviewUpdate) {
            io.setup.docs = { ...io.setup.docs, reviews: io.setup.afterFirstReviewUpdate.current };
            delete io.setup.afterFirstReviewUpdate;
            return mongo(collection, "update", filter, { update }, { modifiedCount: 0 });
          }
          return mongo(collection, "update", filter, { update }, { modifiedCount: 1 });
        },
        deleteOne: async (filter: unknown) =>
          mongo(
            collection,
            "delete",
            filter,
            {},
            { deletedCount: io.setup.deleted ?? 1 },
          ),
      }),
    },
  },
}));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails() {},
    async sendNotification(subscription: unknown, raw: string) {
      io.deliveries.push({
        subscription,
        payload: JSON.parse(raw),
        outcome: io.setup.delivery ?? "sent",
      });
      if (io.setup.delivery === "expired")
        throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (io.setup.delivery === "failed")
        throw new Error("fixture unavailable");
      if (io.setup.delivery === "unnamed") throw new Error("");
    },
  },
}));
vi.mock("../src/clients/epic.js", () => ({
  epicStoreClient: {
    getUser: async (id: string) => {
      const call = { method: "epicUser", id };
      if (io.setup.fault === "epicUser") {
        io.trace.push({ call, error: true });
        throw new Error("fixture lookup failed");
      }
      const result = io.setup.epic ?? null;
      io.trace.push({ call, result });
      return result;
    },
  },
}));
vi.mock("../src/utils/auth.js", () => ({
  getLinkedEpicSession: async () => io.setup.session ? {epicAccountId:"fixture-account",user:{email:"independent-address@fixture.invalid"}} : null,
  auth: {
    api: {
      getSession: async () =>
        io.setup.session
          ? { user: { email: "fixture-account@fixture.invalid" } }
          : null,
    },
  },
}));
vi.mock("../src/clients/redis.js", () => ({ default: {} }));
vi.mock("../src/clients/response-cache.js", () => ({ default: {} }));
vi.mock("../src/clients/discord.js", () => ({ discord: {} }));
vi.mock("../src/clients/telegram.js", () => ({ telegramBotService: {} }));
import reviews from "../src/routes/offers/reviews.js";
import users from "../src/routes/users.js";
import admin from "../src/routes/admin.js";
import push from "../src/routes/push.js";

it("records the account admin handlers' responses and database operations", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("PUSH_ADMIN_API_KEY", "fixture-admin");
  vi.stubEnv("VAPID_PUBLIC_KEY", "fixture-public");
  vi.stubEnv("VAPID_PRIVATE_KEY", "fixture-private");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const status = io.setup.tokenStatus ?? 200;
    const discord = url === "https://discord.com/api/v10/oauth2/@me";
    const google = url === "https://www.googleapis.com/oauth2/v3/certs";
    if (
      !discord &&
      !google &&
      url !== "https://api.epicgames.dev/epic/oauth/v2/tokenInfo"
    )
      throw new Error("Unexpected fixture URL");
    const result = google
      ? { keys: [googleJwk] }
      : discord
        ? { user: io.setup.discord }
        : status === 200
          ? { account_id: "fixture-account", active: true }
          : { error: "rejected" };
    io.http.push({
      method: init.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body?.toString(),
      status,
      result,
    });
    return Response.json(result, { status });
  });
  const app = new Hono()
    .route("/admin", admin)
    .route("/push", push)
    .route("/users", users)
    .route("/offers/:id", reviews);
  const cases: unknown[] = [];
  const cookie =
    "EGDATA_AUTH=" +
    Buffer.from(
      JSON.stringify({
        user: { accountId: "fixture-account", accessToken: "fixture-token" },
      }),
    ).toString("base64") +
    ".fixture";
  async function record(name: string, request: RequestCase, setup: Setup = {}) {
    io.setup = setup;
    io.trace = [];
    io.http = [];
    io.deliveries = [];
    const response = await app.request(request.path, {
      method: request.method,
      headers: request.headers,
      body: request.rawBody ?? JSON.stringify(request.body),
    });
    cases.push({
      name,
      ...(setup.session ? { session: true } : {}),
      request,
      response: await captureResponse(response),
      trace: io.trace,
      http: io.http,
      deliveries: io.deliveries,
    });
    return response.status;
  }
  const owner = { id: "fixture-user", displayName: "Local" };
  const owned = { headers: { authorization: "Bearer fixture-local" } };
  const linked = { epicAccountId: "fixture-epic" };
  await record("users index", { method: "GET", path: "/users" });
  for (const [method, path, body] of [
    ["POST", "/users/find-or-create", owner],
    ["GET", "/users/discord", undefined],
    ["POST", "/users/discord", owner],
    ["PUT", "/users/epic?id=fixture-epic", undefined],
    ["DELETE", "/users/epic", undefined],
  ] as const) {
    const req = { method, path, body };
    await record(method + path + " no credentials", req);
    if (path === "/users/find-or-create") continue;
    const authorized = { ...req, ...owned };
    await record(method + path + " provider declined", authorized, {
      tokenStatus: 401,
    });
    await record(method + path + " no provider profile", authorized);
    await record(method + path + " no account", authorized, { discord: owner });
    await record(method + path + " read failure", authorized, {
      discord: owner,
      fault: "users.one",
    });
    await record(method + path + " current account", authorized, {
      discord: owner,
      rows: [owner],
      epic: linked,
    });
    await record(method + path + " deleted during lookup", authorized, {
      discord: owner,
      rows: [owner],
      epic: linked,
      disappear: true,
    });
    if (method === "POST")
      await record("discord registration write failure", authorized, {
        discord: owner,
        fault: "users.insert",
      });
    if (method === "PUT" || method === "DELETE")
      await record(method + " link write failure", authorized, {
        discord: owner,
        rows: [owner],
        epic: linked,
        fault: "users.update",
      });
  }
  for (const [name, setup] of [
    ["linked", { rows: [owner] }],
    ["unlinked", {}],
    ["known profile", { epic: linked }],
    ["service failure", { fault: "epicUser" }],
    ["storage failure", { fault: "users.one" }],
  ] as const) {
    await record(
      "check epic " + name,
      { method: "GET", path: "/users/check-epic?id=fixture-epic" },
      setup,
    );
  }
  for (const [label, id] of [
    ["null", null],
    ["provided", "user-supplied-test-id"],
  ] as const) {
    await record(
      "discord registration identifier " + label,
      {
        method: "POST",
        path: "/users/discord",
        ...owned,
        body: { ...owner, _id: id },
      },
      { discord: owner },
    );
  }
  const googleRequest = {
    method: "POST",
    path: "/users/find-or-create",
    headers: { authorization: "Bearer " + googleJwt },
    body: { ...owner, email: "fixture@fixture.invalid" },
  };
  await record("google registration new", googleRequest);
  await record("google registration lookup failure", googleRequest, {
    fault: "users.one",
  });
  await record("google registration insert failure", googleRequest, {
    fault: "users.insert",
  });
  await record("google registration preserved falsy date", {
    ...googleRequest,
    body: { ...googleRequest.body, registrationDate: "", createdAt: null },
  });
  await record("google registration existing", googleRequest, {
    rows: [owner],
  });
  await record("google registration user disappeared", googleRequest, {
    rows: [owner],
    disappear: true,
  });
  for (const path of ["/users/find-or-create", "/users/discord"])
    await record(path + " invalid JSON", {
      method: "POST",
      path,
      rawBody: "[",
    });
  const reviewBody = {
    rating: 5,
    title: "Title",
    content: "Text",
    tags: ["news", 2, null, "x", "y", "z"],
    recommended: false,
  };
  const catalog = {
    offers: { id: "o1", namespace: "ns" },
    sandboxes: { _id: "ns", parent: "product" },
    products: { _id: "product" },
  };
  for (const [method, path] of [
    ["POST", "/offers/o1/reviews"],
    ["DELETE", "/offers/o1/reviews"],
    ["GET", "/offers/o1/reviews/permissions"],
  ] as const) {
    const req = {
      method,
      path,
      headers: { cookie: "fixture-session=local" },
      ...(method === "POST" ? { body: reviewBody } : {}),
    };
    await record(method + " review no existing", req, {
      session: true,
      docs: catalog,
    });
    await record(method + " review already exists", req, {
      session: true,
      docs: { ...catalog, reviews: { id: "o1", userId: "fixture-account" } },
    });
    await record(method + " review storage error", req, {
      session: true,
      fault: "reviews.one",
    });
    if (method === "POST") {
      for (const fault of [
        "offers.one",
        "sandboxes.one",
        "products.one",
        "reviews.insert",
      ])
        await record("review failure " + fault, req, {
          session: true,
          docs: catalog,
          fault,
        });
      for (const [label, tags] of [
        ["absent", undefined],
        ["explicit null", null],
        ["string", "abcdef"],
        ["nested", [{ name: "x" }, ["a"], false]],
      ] as const)
        await record(
          "review tags " + label,
          { ...req, body: { ...reviewBody, tags } },
          { session: true, docs: catalog },
        );
      for (const [label, date] of [
        ["past date", new Date("2026-01-01")],
        ["future date", new Date("2027-01-01")],
        ["future date string", "2027-01-01T00:00:00.000Z"],
        ["epoch", 1893456000000],
      ] as const)
        await record("review " + label, req, {
          session: true,
          docs: {
            ...catalog,
            offers: { ...catalog.offers, releaseDate: date },
          },
        });
      await record(
        "review optional explicit null",
        { ...req, body: { ...reviewBody, recommended: null } },
        { session: true, docs: catalog },
      );
      await record(
        "review malformed body",
        { ...req, rawBody: "[" },
        { session: true },
      );
      await record(
        "review without recommendation",
        { ...req, body: { ...reviewBody, recommended: undefined } },
        { session: true, docs: catalog },
      );
    } else if (method === "DELETE")
      await record("review delete write failure", req, {
        session: true,
        docs: { reviews: { id: "o1" } },
        fault: "reviews.delete",
      });
  }
  const reviewPatch = {
    method: "PATCH", path: "/offers/o1/reviews",
    headers: { cookie: "fixture-session=local" },
    body: { ...reviewBody, title: "$title", content: { text: "$content" } },
  };
  const priorReview = {
    _id: new ObjectId("123456789012345678901234"), id: "o1", userId: "fixture-account",
    title: "Before", content: "Original", rating: 2, tags: ["old"], recommended: true,
    updatedAt: new Date("2026-10-01T00:00:00Z"), createdAt: new Date("2026-06-01T00:00:00Z"),
    imported: true,
  };
  for (const [name, edits] of [
    ["first edit", undefined], ["null historical editions", null],
    ["existing history", [{ title: "Earlier" }]],
  ] as const) {
    expect(await record(name, reviewPatch, {
      session: true, docs: { ...catalog, reviews: { ...priorReview, editions: edits } },
    })).toBe(200);
  }
  expect(await record("retry edit after a concurrent edit", reviewPatch, {
    session: true, docs: { ...catalog, reviews: priorReview },
    afterFirstReviewUpdate: { current: { ...priorReview, title: "Other writer", editions: [{ title: "Before" }] } },
  })).toBe(200);
  expect(await record("review removed during edit", reviewPatch, {
    session: true, docs: { ...catalog, reviews: priorReview },
    afterFirstReviewUpdate: { current: null },
  })).toBe(404);
  expect(await record("review missing on edit", reviewPatch, { session: true, docs: catalog })).toBe(404);
  expect(await record("review edit database failure", reviewPatch, {
    session: true, docs: { ...catalog, reviews: priorReview }, fault: "reviews.update",
  })).toBe(500);
  await record("admin missing session", { method: "GET", path: "/admin" });
  for (const role of ["admin", "editor", "viewer"])
    await record(
      "admin role " + role,
      { method: "GET", path: "/admin", headers: { cookie } },
      { role },
    );
  await record(
    "admin token rejected",
    { method: "GET", path: "/admin", headers: { cookie } },
    { tokenStatus: 401 },
  );
  await record(
    "admin account lookup fails",
    { method: "GET", path: "/admin", headers: { cookie } },
    { fault: "epic.one" },
  );
  for (const method of ["POST", "PATCH"]) {
    const base = { method, path: "/admin/offers", headers: { cookie } };
    await record(
      method + " denied",
      { ...base, body: { id: "fixture" } },
      { role: "viewer" },
    );
    await record(method + " invalid JSON", { ...base, rawBody: "{" });
    await record(method + " missing id", { ...base, body: { title: "Title" } });
    for (const id of ["fixture", 17, 0]) {
      const body = { id, title: "Title" };
      await record(method + " missing " + JSON.stringify(id), {
        ...base,
        body,
      });
      await record(
        method + " existing " + JSON.stringify(id),
        { ...base, body },
        { rows: [body] },
      );
    }
    await record(
      method + " offer lookup fails",
      { ...base, body: { id: "fixture" } },
      { fault: "offers.one" },
    );
    await record(
      method + " offer write fails",
      { ...base, body: { id: "fixture" } },
      {
        rows: method === "POST" ? [] : [{ id: "fixture" }],
        fault: method === "POST" ? "offers.insert" : "offers.update",
      },
    );
  }
  const user = { "x-api-key": "fixture-user" };
  const fixture = { id: "own-sub", topics: ["offers", "news", "news"] };
  const topicBody = { subscriptionId: fixture.id, topics: ["news", "updates"] };
  const endpoint = {
    endpoint: "https://push.invalid/test",
    keys: { p256dh: "fixture", auth: "local" },
  };
  const reads = [
    ["GET", "/push/subscribe", "many"],
    ["GET", "/push/subscriptions", "many"],
    ["GET", "/push/subscriptions/own-sub", "one"],
    ["GET", "/push/topics/stats", "aggregate"],
    ["DELETE", "/push/unsubscribe/own-sub", "delete"],
  ] as const;
  for (const [method, path, operation] of reads) {
    const req = { method, path, headers: user };
    await record(path + " auth", { method, path });
    await record(path + " empty", req, { deleted: 0 });
    await record(path + " populated", req, {
      rows:
        operation === "aggregate" ? [{ _id: "offers", count: 3 }] : [fixture],
    });
    await record(path + " failure", req, {
      fault: "pushsubscriptions." + operation,
    });
  }
  for (const action of ["subscribe", "unsubscribe"]) {
    const req = {
      method: "POST",
      path: "/push/topics/" + action,
      headers: user,
      body: topicBody,
    };
    await record(action + " missing credentials", { ...req, headers: {} });
    await record(action + " malformed JSON", { ...req, rawBody: "[" });
    await record(action + " malformed payload", { ...req, body: null });
    await record(action + " missing subscription", req);
    await record(action + " topics", req, { rows: [fixture] });
    await record(
      action + " mixed topics",
      {
        ...req,
        body: {
          ...topicBody,
          topics: [2, 2, null, "news", { x: 1 }, { x: 1 }],
        },
      },
      { rows: [{ ...fixture, topics: [2, null, "news", "keep", { x: 1 }] }] },
    );
    await record(action + " historical row missing topics", req, {
      rows: [{ id: fixture.id }],
    });
    await record(action + " read failure", req, {
      fault: "pushsubscriptions.one",
    });
    await record(action + " write failure", req, {
      rows: [fixture],
      fault: "pushsubscriptions.update",
    });
  }
  const subscribe = {
    method: "POST",
    path: "/push/subscribe",
    headers: user,
    body: endpoint,
  };
  await record("push subscribe existing", subscribe, { rows: [fixture] });
  await record("push subscribe read failure", subscribe, {
    fault: "pushsubscriptions.one",
  });
  await record("push subscribe bad endpoint", {
    ...subscribe,
    body: { endpoint: 1 },
  });
  await record("push subscribe bad key", {
    ...subscribe,
    body: { ...endpoint, keys: {} },
  });
  await record("push subscribe missing auth key", {
    ...subscribe,
    body: { ...endpoint, keys: { p256dh: "fixture" } },
  });
  const notification = { title: "Title", body: "Body" };
  for (const [path, body] of [
    ["/push/send", { topic: "offers:news", notification }],
    ["/push/send-to-user", { userId: "fixture-user", notification }],
  ] as const) {
    const req = {
      method: "POST",
      path,
      body,
      headers: { "x-api-key": "fixture-admin" },
    };
    const subscriber = { ...endpoint, id: "own-sub" };
    for (const outcome of [undefined, "failed", "unnamed", "expired"] as const)
      await record(path + " delivery " + (outcome ?? "sent"), req, {
        rows: [subscriber],
        delivery: outcome,
      });
    await record(path + " stale cleanup failure", req, {
      rows: [subscriber],
      delivery: "expired",
      fault: "pushsubscriptions.delete",
    });
    await record(path + " historical row missing keys", req, {
      rows: [{ id: "own-sub", endpoint: subscriber.endpoint }],
    });
    if (path === "/push/send-to-user")
      await record(
        "send to user array payload",
        { ...req, body: { ...body, notification: [] } },
        { rows: [subscriber] },
      );
    else {
      const act = {
        action: { type: "open", url: "/news", ignored: true },
        title: "Open",
        icon: "icon",
        extra: "ignored",
      };
      await record(
        "notification field selection",
        {
          ...req,
          body: {
            ...body,
            notification: {
              ...notification,
              image: "strip",
              data: { strip: true },
              icon: "icon",
              badge: "badge",
              actions: [act, { action: { type: "close" }, title: "Close" }],
            },
          },
        },
        { rows: [subscriber] },
      );
      for (const [name, value] of Object.entries({
        image: { image: 0 },
        icon: { icon: false },
        actions: { actions: false },
        missingInner: { actions: [{}] },
        invalidAction: { actions: [{ ...act, action: { type: "no" } }] },
        invalidUrl: { actions: [{ ...act, action: { type: "open", url: 2 } }] },
        missingType: { actions: [{ ...act, action: {} }] },
        invalidTitle: { actions: [{ ...act, title: 1 }] },
        invalidIcon: { actions: [{ ...act, icon: 7 }] },
        invalidActionShape: { actions: [null] },
        missingBody: { body: null },
        missingTitle: { title: null },
      }))
        await record("notification invalid " + name, {
          ...req,
          body: { ...body, notification: { ...notification, ...value } },
        });
    }
    await record(path + " empty recipients", req);
    await record(path + " read failure", req, {
      fault: "pushsubscriptions.many",
    });
    await record(path + " bad JSON", { ...req, rawBody: "[" });
    await record(path + " missing admin key", { ...req, headers: {} });
  }
  await record("push public key", {
    path: "/push/vapid-public-key",
    method: "GET",
  });
  for (const method of ["POST", "PATCH"])
    await record("admin offers no session " + method, {
      method,
      path: "/admin/offers",
      body: { id: "local" },
    });
  const notify = {
    method: "POST",
    path: "/push/send",
    headers: { "x-api-key": "fixture-admin" },
  };
  await record("notification simple topic", {
    ...notify,
    body: { topic: "offers", notification },
  });
  await record("notification invalid top level", { ...notify, body: null });
  await record("notification missing topic", {
    ...notify,
    body: { notification },
  });
  await record("subscription missing auth", {
    method: "POST",
    path: "/push/subscribe",
    body: endpoint,
  });
  await record("subscription wrong body", {
    method: "POST",
    path: "/push/subscribe",
    headers: user,
    body: false,
  });
  await record("subscription missing keys", {
    method: "POST",
    path: "/push/subscribe",
    headers: user,
    body: { endpoint: endpoint.endpoint },
  });
  await record("subscription historical missing id", subscribe, {
    rows: [{ endpoint: endpoint.endpoint }],
  });
  await record(
    "statistics omit missing fields",
    { method: "GET", path: "/push/topics/stats", headers: user },
    { rows: [{ _id: "topic" }, { count: 1 }, { _id: null, count: null }] },
  );
  for (const action of ["subscribe", "unsubscribe"])
    await record(
      "topic string history " + action,
      {
        method: "POST",
        path: "/push/topics/" + action,
        headers: user,
        body: topicBody,
      },
      { rows: [{ id: "own-sub", topics: "a🦀a" }] },
    );
  await record("user push null JSON", {
    method: "POST",
    path: "/push/send-to-user",
    headers: { "x-api-key": "fixture-admin" },
    body: null,
  });
  for (const method of ["POST", "PATCH"])
    await record("admin null JSON " + method, {
      method,
      path: "/admin/offers",
      headers: { cookie },
      body: null,
    });
  expect(cases.length).toBeGreaterThan(70);
  assertOracle("legacy-account-admin-http-node", cases);
});
it("records the Mongo driver wire representation of account JSON fields", () => {
  const inputs = [
    "null",
    "true",
    "false",
    "0",
    "-0.0",
    "1",
    "-2147483648",
    "2147483647",
    "2147483648",
    "0.25",
    "9007199254740993",
    "9223372036854775809",
    '"text"',
    '{"$oid":"000000000000000000000001"}',
    '{"nested":[1,2.5,null,{"$date":"fixture"}]}',
  ];
  assertOracle(
    "legacy-account-json-bson-node",
    inputs.map((raw) => ({
      raw,
      bytes: Buffer.from(BSON.serialize({ value: JSON.parse(raw) })).toString("hex"),
    })),
  );
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
