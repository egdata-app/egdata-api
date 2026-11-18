// Compare actual HTTP listeners against a disposable MongoDB/Redis/Postgres stack.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Redis } from "ioredis";
import { Binary, Decimal128, Long, MongoClient, ObjectId, Timestamp, UUID } from "mongodb";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";

const profileId = "00000000000000000000000000000042";
const profileQuery = `query FixtureProfile($id: ID!) {
  profile(id: $id) {
    accountId displayName reviewsCount
    highlights { totalGames totalAchievements reviewsCount }
    games(limit: 1) { total elements { sandboxId title unlocked } }
    achievements(limit: 1) { total elements { name displayName xp unlockedAt } }
    recentActivity(limit: 1) { type occurredAt }
  }
}`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(command + " failed with status " + result.status);
}

function fixtureMongo(services) {
  return new MongoClient(services.EGDATA_TEST_MONGO, {
    tls: true,
    authMechanism: "MONGODB-X509",
    authSource: "$external",
    tlsCAFile: services.EGDATA_TEST_MONGO_CA,
    tlsCertificateKeyFile: services.EGDATA_TEST_MONGO_CERT,
  });
}

async function indexFixture(services, index, id, document) {
  const response = await fetch(
    services.EGDATA_TEST_OPENSEARCH + "/" + index + "/_doc/" + encodeURIComponent(id) + "?refresh=wait_for",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from("admin:Fixture-Only-Search-42!").toString("base64"),
      },
      body: JSON.stringify(document),
    },
  );
  assert.ok(response.ok, "index " + index + "/" + id + " returned HTTP " + response.status);
}

async function seedCatalog(rustDir, services) {
  const mongo = fixtureMongo(services);
  try {
    const path = join(
      rustDir,
      "crates/egdata-api/tests/fixtures/offers-http-node.json",
    );
    const records = JSON.parse(readFileSync(path, "utf8"));
    const { offer, prices, localizations } = records.find(
      (r) => r.name === "localized-us-detail-with-price",
    ).input;
    await indexFixture(services, "egdata.offers", offer.id, {
      ...offer,
      keyImages: [{ type: "Thumbnail", metadata: { $oid: "archived image reference" } }],
      prices: { US: {
        offerId: offer.id, region: "US",
        price: { currencyCode: "USD", discountPrice: 349.8, metadata: { $date: "archived price" } },
      } },
    });
    const db = mongo.db("egdata");
    const buildFixtures = JSON.parse(
      readFileSync(
        join(
          rustDir,
          "crates/egdata-api/tests/fixtures/build-reads-http-node.json",
        ),
        "utf8",
      ),
    );
    const { build, baseSnapshot, baseFiles, fileRows } = buildFixtures.find(
      (c) =>
        c.input?.baseFiles?.length &&
        c.input?.fileRows?.length &&
        c.input?.baseSnapshot &&
        c.input?.build,
    ).input;
    for (const [index, [snapshot, files]] of [
      [build, fileRows],
      [baseSnapshot, baseFiles],
    ].entries()) {
      await db.collection("builds").insertOne({
        ...snapshot,
        _id: new ObjectId(String(index + 1).padStart(24, "0")),
        createdAt: new Date(snapshot.createdAt),
        firstSeenAt: new Date(snapshot.firstSeenAt),
        updatedAt: new Date(snapshot.updatedAt),
      });
      await db.collection("files").insertMany(
        files.map(({ _id, ...file }) => ({
          ...file,
          manifestId: snapshot.manifestId,
          buildVersion: snapshot.buildVersion,
        })),
      );
    }
    await db.collection("offers").insertOne({
      ...offer,
      items: [{ namespace: offer.namespace, id: "fixture" }],
      isCodeRedemptionOnly: false,
      lastModifiedDate: new Date(offer.lastModifiedDate),
    });
    await db.collection("storefront-modules").insertMany([
      { eventSlug: "the-game-awards", title: "  Nominated  ", offers: [{ id: offer.id }] },
      { eventSlug: "the-game-awards", title: "Archived", offers: [{ id: "absent-from-catalog" }] },
    ]);
    // Insert the older price first so a missing descending sort is observable.
    const pricedId = "regional-price-fixture";
    await db.collection("collections_v2").insertOne({
      _id: "ranked-fixture", name: ["Ranked", 2025], updatedAt: new Date("2025-07-17T00:00:00Z"),
    });
    await db.collection("game_positions").insertOne({
      collectionId: "ranked-fixture", offerId: pricedId, position: 1, previous: Decimal128.fromString("2.5"),
      positions: [{ position: 1, date: new Date("2025-07-16T00:00:00Z"), metadata: { $oid: "literal" } }],
    });
    await db.collection("offers").insertOne({ id: pricedId, namespace: "ns-price", offerType: "BASE_GAME", title: "Regional price" });
    await db.collection("offersubitems").insertOne({ _id: pricedId, subItems: [{ id: "fixture" }] });
    await db.collection("pricev2").insertMany([
      { offerId: pricedId, region: "US", updatedAt: new Date("2024-01-01"), price: { currencyCode: "USD", discountPrice: 999 } },
      { offerId: pricedId, region: "US", updatedAt: new Date("2024-02-01"), price: { currencyCode: "USD", discountPrice: Decimal128.fromString("349.8") } },
    ]);
    await db.collection("media").insertOne({
      _id: offer.id,
      images: [],
      metadata: {
        capture: new Timestamp({ t: 4_000_000_000, i: 61 }),
        revision: Long.fromString("9007199254740993"),
        precision: Decimal128.fromString("12.3400"),
        digest: new Binary(Buffer.from([0, 127, 255])),
        source: new UUID("00112233-4455-4677-8899-aabbccddeeff"),
        oldestDate: new Date(-8640000000000000),
        newestDate: new Date(8640000000000000),
        storedLabels: [{ $oid: "historic alias" }, { $date: "spring" }],
        event: { updatedAt: "2024-04-31T09:30:00+02:00" },
      },
    });
    // Mongo can store an int64 outside the range accepted by the JavaScript Date constructor.
    await db.collection("media").updateOne({ _id: offer.id }, [
      { $set: { "metadata.outsideDateRange": { $toDate: Long.MAX_VALUE } } },
    ]);
    await db.collection("items").insertOne({
      id: "fixture",
      namespace: offer.namespace,
      title: "Oracle Item",
      creationDate: "2024-02-03",
      linkedOffers: [offer.id],
      lastModifiedDate: new Date(offer.lastModifiedDate),
    });
    await db.collection("sandboxes").insertOne({ _id: offer.namespace, name: "Oracle Sandbox" });
    await db.collection("freegames").insertOne({
      id: offer.id,
      namespace: offer.namespace,
      platform: "PC",
      startDate: new Date("2024-02-01T00:00:00Z"),
      endDate: new Date("2024-02-08T00:00:00Z"),
    });
    await db
      .collection("pricev2")
      .insertMany(
        prices.map((p) => ({ ...p, updatedAt: new Date(p.updatedAt) })),
      );
    await db
      .collection("egs_localizations")
      .insertMany(
        localizations.map((l) => ({ ...l, fetchedAt: new Date(l.fetchedAt) })),
      );
    await db.collection("player-achievements").insertOne({
      epicAccountId: profileId,
      sandboxId: offer.namespace,
      totalUnlocked: 1,
      totalXP: 25,
      playerAchievements: [
        {
          playerAchievement: {
            sandboxId: offer.namespace,
            achievementSetId: "fixture-set",
            achievementName: "explorer",
            unlocked: true,
            unlockDate: new Date("2025-03-01T16:00:00Z"),
          },
        },
      ],
    });
    await db.collection("achievementsets").insertOne({
      sandboxId: offer.namespace,
      achievementSetId: "fixture-set",
      achievements: [
        {
          name: "explorer",
          displayName: "Explorer",
          xp: 25,
          completedPercent: 0.125,
        },
      ],
    });
    // Supply only the external Epic identity. Each origin builds child fields from Mongo independently.
    const cache = new Redis(services.EGDATA_TEST_REDIS);
    try {
      const identity = JSON.stringify({
        accountId: profileId,
        displayName: "Fixture Player",
        reviewsCount: 2,
      });
      for (const prefix of ["fixture:node:", "response:v2:"]) {
        await cache.set(prefix + "epic-me:" + profileId, identity, "EX", 3600);
        for (const ttl of [60, 3600]) {
          const key = "v1:profiles.identity:id=" + JSON.stringify(profileId) + ":ttl=" + ttl;
          await cache.set(prefix + key, JSON.stringify({ epicAccountId: profileId, displayName: "Fixture Player" }), "EX", ttl);
        }
        await cache.set(
          prefix + "graphql:profile:" + profileId + ":identity:v2",
          identity,
          "EX",
          3600,
        );
      }
    } finally {
      await cache.quit();
    }
  } finally {
    await mongo.close();
  }
}

async function compareSearchMappings(root, temp, env, runOrigin) {
  const inspect = () => {
    const node = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/tsx/dist/cli.mjs"),
        join(root, "scripts/ensure-v1-search-mappings.ts"),
      ],
      { cwd: temp, env, encoding: "utf8" },
    );
    const rust = runOrigin(["ensure-v1-search-mappings"]);
    assert.equal(rust.status, node.status);
    const actual = JSON.parse(rust.stdout);
    assert.deepEqual(actual, JSON.parse(node.stdout));
    return actual;
  };
  const before = inspect();
  assert.deepEqual(before.find((r) => r.index === "egdata.items").missing, [
    "* (index does not exist)",
  ]);
  const keywordText = {
    type: "text",
    fields: { keyword: { type: "keyword" } },
  };
  const response = await fetch(env.OPENSEARCH_URL + "/egdata.items", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " +
        Buffer.from(
          env.OPENSEARCH_USERNAME + ":" + env.OPENSEARCH_PASSWORD,
        ).toString("base64"),
    },
    body: JSON.stringify({
      mappings: {
        properties: {
          id: keywordText,
          namespace: keywordText,
          entitlementType: keywordText,
        },
      },
    }),
  });
  assert.equal(response.ok, true, "create isolated items index");
  const apply = runOrigin(["ensure-v1-search-mappings", "--apply"]);
  const items = JSON.parse(apply.stdout).find(
    (r) => r.index === "egdata.items",
  );
  assert.deepEqual(items.applied, ["lastModifiedDate"]);
  assert.deepEqual(
    inspect().find((r) => r.index === "egdata.items").missing,
    [],
  );
  console.log(
    "OpenSearch mapping reports match Node before and after adding the missing items mapping.",
  );
}

async function compareReviewEdits(origins, services, ownerCookie, otherCookie) {
  const mongo = fixtureMongo(services);
  try {
    const db = mongo.db("egdata");
    const reviews = db.collection("reviews");
    const historical = {
      title: "First edition",
      metadata: { source: "legacy" },
    };
    const reviewFields = (title, rating) => ({
      title,
      rating,
      content: "Review " + title,
      tags: ["one", "two", "three", "four", "five", "six"],
      recommended: rating >= 3,
    });
    const editionOf = (review, createdAt) => ({
      rating: review.rating,
      title: review.title,
      content: review.content,
      tags: review.tags.slice(0, 5),
      recommended: review.recommended,
      createdAt,
    });
    for (const [label, origin] of Object.entries(origins)) {
      const id = "fixture-review-" + label;
      const missing = id + "-missing";
      const createId = id + "-create";
      const namespace = id + "-sandbox";
      const product = id + "-product";
      const initial = {
        _id: new ObjectId(),
        ...reviewFields("Seed", 2),
        tags: ["classic"],
        id,
        userId: profileId,
        createdAt: new Date("2023-02-01T00:00:00.000Z"),
        updatedAt: new Date("2023-02-02T00:00:00.000Z"),
        verified: true,
        votes: 17,
        moderation: { state: "approved" },
        editions: [historical],
      };
      await db.collection("products").insertOne({ _id: product });
      await db
        .collection("sandboxes")
        .insertOne({ _id: namespace, parent: product });
      await db.collection("offers").insertMany([
        { id, namespace },
        { id: missing, namespace },
        {
          id: createId,
          namespace,
          releaseDate: new Date("2023-01-01T00:00:00Z"),
        },
      ]);
      const { insertedId } = await reviews.insertOne(initial);
      const read = () => reviews.findOne({ _id: insertedId });
      const request = async (
        method,
        path,
        cookie,
        fields,
        status,
        expected,
      ) => {
        const res = await fetch(origin + "/offers/" + path, {
          method,
          headers: {
            "content-type": "application/json",
            "x-egdata-origin-token": "fixture-origin-token",
            cookie,
          },
          body: JSON.stringify(fields),
        });
        const text = await res.text();
        assert.equal(
          res.status,
          status,
          label + " " + method + " " + path + ": " + text,
        );
        assert.match(
          res.headers.get("content-type") ?? "",
          /^application\/json\b/,
        );
        assert.deepEqual(JSON.parse(text), expected);
      };
      const patch = (offer, cookie, fields, status) =>
        request(
          "PATCH",
          offer + "/reviews",
          cookie,
          fields,
          status,
          status === 200 ? { status: "ok" } : { message: "Review not found" },
        );
      await request(
        "GET",
        createId + "/ownership",
        ownerCookie,
        undefined,
        200,
        { isOwned: false },
      );
      const newFields = reviewFields("Original", 3);
      await request(
        "POST",
        createId + "/reviews",
        ownerCookie,
        newFields,
        201,
        { status: "ok" },
      );
      const created = await reviews.findOne({ id: createId });
      assert.ok(created?._id instanceof ObjectId);
      assert.ok(
        created.createdAt instanceof Date && created.updatedAt instanceof Date,
      );
      assert.deepEqual(created, {
        ...newFields,
        tags: newFields.tags.slice(0, 5),
        id: createId,
        userId: profileId,
        verified: false,
        _id: created._id,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      });
      await request(
        "POST",
        createId + "/reviews",
        ownerCookie,
        newFields,
        400,
        { message: "User already reviewed this product" },
      );
      assert.equal(await reviews.countDocuments({ id: createId }), 1);
      const edit = reviewFields("Edited", 4);
      await patch(id, otherCookie, edit, 404);
      await patch(missing, ownerCookie, edit, 404);
      assert.deepEqual(await read(), initial);
      assert.equal(await reviews.countDocuments({ id: missing }), 0);

      await patch(id, ownerCookie, edit, 200);
      const edited = await read();
      assert.ok(
        edited.updatedAt instanceof Date &&
          edited.updatedAt > initial.updatedAt,
      );
      assert.deepEqual(edited, {
        ...initial,
        ...edit,
        tags: edit.tags.slice(0, 5),
        verified: false,
        updatedAt: edited.updatedAt,
        editions: [historical, editionOf(initial, initial.updatedAt)],
      });

      const concurrent = [
        reviewFields("Parallel A", 1),
        reviewFields("Parallel B", 5),
      ];
      await Promise.all(
        concurrent.map((fields) => patch(id, ownerCookie, fields, 200)),
      );
      const final = await read();
      assert.equal(
        final.editions.length,
        4,
        label + " retained both parallel edits",
      );
      const previous = concurrent.find(
        (fields) => fields.title === final.editions[3].title,
      );
      const last = concurrent.find((fields) => fields.title === final.title);
      assert.ok(previous && last && previous !== last);
      assert.ok(final.editions[3].createdAt instanceof Date);
      assert.ok(final.updatedAt instanceof Date);
      assert.deepEqual(final, {
        ...edited,
        ...last,
        tags: last.tags.slice(0, 5),
        updatedAt: final.updatedAt,
        editions: [
          ...edited.editions,
          editionOf(edited, edited.updatedAt),
          editionOf(previous, final.editions[3].createdAt),
        ],
      });
      assert.equal(await reviews.countDocuments({ id }), 1);
      await reviews.deleteOne({ _id: insertedId });
      await reviews.deleteOne({ _id: created._id });
      await db.collection("offers").deleteMany({ namespace });
      await db.collection("sandboxes").deleteOne({ _id: namespace });
      await db.collection("products").deleteOne({ _id: product });
    }
    console.log(
      "Both origins returned unavailable game ownership as false, persisted a new review, rejected its duplicate, and preserved ownership, metadata and all editions across concurrent edits. Missing and other-owner reviews returned 404.",
    );
  } finally {
    await mongo.close();
  }
}

async function comparePrivateProfile(nodeOrigin, rustOrigin, services) {
  const database = new pg.Pool({ connectionString: services.EGDATA_TEST_PG });
  try {
    const config = {
      database,
      secret: "fixture-origin-session-secret-used-locally",
      baseURL: "https://fixture.example",
      emailAndPassword: { enabled: true },
    };
    const migration = await getMigrations(config);
    await migration.runMigrations();
    const issuer = betterAuth(config);
    const linkedSession = async (accountId, name) => {
      const signup = await issuer.api.signUpEmail({
        body: {
          email: name + "@example.invalid",
          name,
          password: "Disposable-Profile-42!",
        },
        asResponse: true,
      });
      assert.equal(signup.status, 200, "disposable account registration");
      const { user } = await signup.json();
      const session = signup.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .find((value) =>
          /^(?:__Secure-)?better-auth\.session_token=/.test(value),
        );
      assert.ok(session, "Better Auth issued a session cookie");
      await database.query(
        'INSERT INTO "account" ("id","accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,NOW(),NOW())',
        ["fixture-epic-link-" + name, accountId, "epic", user.id],
      );
      return session;
    };
    const session = await linkedSession(profileId, "fixture-owner");
    async function check(cookie, etag, status) {
      const read = async (origin) => {
        const headers = new Headers({
          "x-egdata-origin-token": "fixture-origin-token",
        });
        if (cookie) headers.set("cookie", cookie);
        if (etag) headers.set("if-none-match", etag);
        const res = await fetch(origin + "/profiles/me", { headers });
        assert.equal(res.status, status, origin + " private profile");
        assert.equal(res.headers.get("cache-control"), "private, no-store");
        return { etag: res.headers.get("etag"), body: await res.text() };
      };
      const [node, rust] = await Promise.all([
        read(nodeOrigin),
        read(rustOrigin),
      ]);
      assert.deepEqual(rust, node);
      return node;
    }
    await check(null, null, 401);
    const authorized = await check(session, null, 200);
    assert.equal(JSON.parse(authorized.body).accountId, profileId);
    assert.ok(authorized.etag);
    await check(session, authorized.etag, 304);
    const otherSession = await linkedSession(
      "00000000000000000000000000000043",
      "fixture-other",
    );
    await compareReviewEdits(
      { node: nodeOrigin, rust: rustOrigin },
      services,
      session,
      otherSession,
    );
    await issuer.api.signOut({ headers: new Headers({ cookie: session }) });
    await check(session, null, 401);
    console.log(
      "Both origins matched on anonymous, authenticated, conditional and revoked private profile reads.",
    );
  } finally {
    await database.end();
  }
}

async function compareStoredMedia(nodeOrigin, rustOrigin) {
  const headers = {
    "x-egdata-origin-token": "fixture-origin-token",
    "x-egdata-worker-token": "fixture-origin-token",
    "x-egdata-key-id": "key_fixture",
    "x-egdata-key-tier": "free",
  };
  for (const prefix of ["", "/v1"]) {
    const path = prefix + "/offers/oracle-game/media";
    const [node, rust] = await Promise.all([nodeOrigin, rustOrigin].map(async origin => {
      const response = await fetch(origin + path, { headers });
      assert.equal(response.status, 200, path);
      const body = await response.text();
      const etag = response.headers.get("etag");
      assert.ok(etag, path);
      return { body, etag };
    }));
    assert.deepEqual(rust, node, path);
    const payload = JSON.parse(node.body);
    const metadata = (prefix ? payload.data : payload).metadata;
    assert.equal(metadata.oldestDate, "-271821-04-20T00:00:00.000Z");
    assert.equal(metadata.newestDate, "+275760-09-13T00:00:00.000Z");
    assert.equal(metadata.outsideDateRange, null);
    assert.deepEqual(metadata.storedLabels, [{ $oid: "historic alias" }, { $date: "spring" }]);
    assert.equal(metadata.event.updatedAt, prefix ? "2024-05-01T07:30:00.000Z" : "2024-04-31T09:30:00+02:00");
    assert.deepEqual(metadata.revision, { high: 2097152, low: 1, unsigned: false });
    if (prefix) {
      assert.deepEqual(metadata.capture, { high: -294967296, low: 61, unsigned: true });
      assert.deepEqual(metadata.digest.buffer, { 0: 0, 1: 127, 2: 255 });
      assert.equal(metadata.source.sub_type, 4);
      assert.equal(Object.keys(metadata.precision.bytes).length, 16);
    } else {
      assert.equal(metadata.capture.$timestamp, "17179869184000000061");
      assert.equal(metadata.precision.$numberDecimal, "12.3400");
      assert.equal(metadata.digest, "AH//");
      assert.equal(metadata.source, "00112233-4455-4677-8899-aabbccddeeff");
    }
  }
  console.log("Both origins returned byte-identical stored BSON media on the legacy and v1 routes.");
}

async function compareHydration(nodeOrigin, rustOrigin) {
  const identifiers = [
    { type: "item", namespace: "ns-oracle", id: "fixture" },
    { type: "item", namespace: "ns-oracle", id: "missing" },
  ];
  for (const path of ["/catalog/hydrate", "/v1/catalog/hydrate"]) {
    const compare = async (knownRoots, knownRecords) => {
      const read = async (origin) => {
        const response = await fetch(origin + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-egdata-origin-token": "fixture-origin-token",
            "x-egdata-worker-token": "fixture-origin-token",
            "x-egdata-key-id": "key_fixture",
            "x-egdata-key-tier": "free",
          },
          body: JSON.stringify({
            schemaVersion: 2,
            identifiers,
            knownRoots,
            knownRecords,
          }),
        });
        assert.equal(response.status, 200, path);
        assert.match(
          response.headers.get("content-type"),
          /application\/x-ndjson/,
        );
        assert.equal(response.headers.get("etag"), null);
        const raw = await response.text();
        assert.ok(
          raw.endsWith("\n"),
          "hydration must terminate the last NDJSON record",
        );
        const rows = raw
          .slice(0, -1)
          .split("\n")
          .map((line) => {
            const { hydratedAt, ...row } = JSON.parse(line);
            assert.equal(new Date(hydratedAt).toISOString(), hydratedAt);
            return row;
          });
        assert.deepEqual(
          rows.map((row) => row.identifier),
          identifiers,
        );
        return {
          rows,
          cache: response.headers.get("cache-control"),
          contentType: response.headers.get("content-type"),
        };
      };
      const [node, rust] = await Promise.all([
        read(nodeOrigin),
        read(rustOrigin),
      ]);
      assert.deepEqual(rust, node, path);
      return node.rows;
    };
    const [resolved, missing] = await compare([], []);
    assert.equal(resolved.status, "resolved");
    assert.ok(
      resolved.records.some(
        ({ record }) =>
          record.type === "offer-item" && record.offerId === "oracle-game",
      ),
    );
    assert.equal(missing.status, "not-found");
    const [unchanged] = await compare(
      [{ rootKey: resolved.rootKey, graphHash: resolved.graphHash }],
      [],
    );
    assert.equal(unchanged.status, "unchanged");
    const [known] = await compare(
      [],
      resolved.records.map(({ recordKey, sha256 }) => ({ recordKey, sha256 })),
    );
    assert.deepEqual(known.records, []);
  }
  console.log(
    "Six catalog hydration streams matched, including known roots, known records and missing items.",
  );
}

async function compareItemCursors(nodeOrigin, rustOrigin, services) {
  const mongo = fixtureMongo(services);
  try {
    const db = mongo.db("egdata");
    const first = new Date("2099-08-10T00:00:00Z");
    const second = new Date("2099-08-09T00:00:00Z");
    const item = "cross-origin-page-fixture";
    const oid = new ObjectId("65ba12345678901234567890");
    await db.collection("items").insertMany([
      { id: oid, lastModifiedDate: first },
      { id: item, lastModifiedDate: second },
    ]);
    const metadata = { contextId: item, contextType: "item" };
    await db.collection("changelogs_v2").insertMany([
      { _id: Decimal128.fromString("51.25"), timestamp: first, metadata },
      { _id: "older-fixture-change", timestamp: second, metadata },
    ]);
    const headers = {
      "x-egdata-origin-token": "fixture-origin-token",
      "x-egdata-worker-token": "fixture-origin-token",
      "x-egdata-key-id": "key_fixture",
      "x-egdata-key-tier": "free",
    };
    async function page(origin, path) {
      const response = await fetch(origin + path, { headers });
      assert.equal(response.status, 200, path);
      return response.json();
    }
    const origins = [nodeOrigin, rustOrigin];
    for (const [path, field, firstId, lastId, tieBreaker, total] of [
      ["/v1/items?limit=1", "id", oid.toHexString(), item, null, await db.collection("items").countDocuments({})],
      ["/v1/items/" + item + "/changelog?limit=1", "_id", "51.25", "older-fixture-change", "51.25", 2],
    ]) {
      const initial = await Promise.all(origins.map((origin) => page(origin, path)));
      assert.deepEqual(initial[0].data, initial[1].data);
      const tokens = initial.map((response) => {
        assert.equal(response.data[0][field], firstId);
        assert.equal(response.meta.pagination.hasMore, true);
        assert.equal(response.meta.pagination.total, total, path);
        const token = response.meta.pagination.nextCursor;
        const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
        assert.deepEqual(payload.last, [first.toISOString(), tieBreaker]);
        return token;
      });
      const next = await Promise.all(origins.map((origin, i) =>
        page(origin, path + "&cursor=" + encodeURIComponent(tokens[1 - i]))));
      assert.deepEqual(next[0].data, next[1].data);
      for (const response of next) assert.equal(response.meta.pagination.total, total, path);
      assert.equal(next[0].data[0][field], lastId);
    }
    console.log("Both packaged origins continued each other's signed item and changelog cursors and returned the complete MongoDB count on each page.");
  } finally {
    await mongo.close();
  }
}

async function compareLegacyPagination(nodeOrigin, rustOrigin, services) {
  const client = fixtureMongo(services);
  try {
    const db = client.db("egdata");
    const offers = db.collection("offers");
    if (!(await offers.indexes()).some(index => index.textIndexVersion)) {
      await offers.createIndex({ title: "text" });
    }
    const offerId = "legacy-numeric-page-offer";
    const word = "numericpagefixture";
    await offers.insertOne({ id: offerId, namespace: "ns-pagination", title: word });
    const changelogIds = ["legacy-numeric-page-1", "legacy-numeric-page-2"];
    await db.collection("changelogs_v2").insertMany(changelogIds.map((_id, i) => ({
      _id, timestamp: new Date(Date.UTC(2101, 0, 2 - i)), metadata: {},
    })));

    for (const [path, status, check] of [
      ["/autocomplete?query=" + word + "&limit=invalid", 200, body => {
        assert.equal(body.total, 1); assert.equal(body.elements[0].id, offerId);
      }],
      ["/changelist?limit=invalid", 200, rows => assert.deepEqual(rows.slice(0, 2).map(row => row._id), changelogIds)],
      ["/changelist?page=invalid&limit=1", 200, rows => assert.deepEqual(rows.map(row => row._id), changelogIds.slice(0, 1))],
      ["/changelist?page=2&limit=-1", 500],
      ["/changelist?page=900000000000000000001", 200, rows => assert.deepEqual(rows, [])],
      ["/sales?limit=invalid", 500],
      ["/sales?page=900000000000000000001", 500],
    ]) {
      const responses = await Promise.all([nodeOrigin, rustOrigin].map(async origin => {
        const result = await fetch(origin + path, {headers: { "x-egdata-origin-token": "fixture-origin-token" }});
        assert.equal(result.status, status, origin + path);
        const body = await result.text();
        if (check) check(JSON.parse(body));
        return { body, cache: result.headers.get("cache-control"), etag: result.headers.get("etag") };
      }));
      assert.deepEqual(responses[0], responses[1], path);
    }
    console.log("Seven legacy numeric pagination cases matched across the two listeners against seeded MongoDB.");
  } finally {
    await client.close();
  }
}

async function compareStoredGiveaways(nodeOrigin, rustOrigin, services) {
  const client = fixtureMongo(services);
  try {
    const db = client.db("egdata");
    const desktop = Decimal128.fromString("1718.50");
    const mobile = new UUID("87bb409f-5b53-4f73-892b-02d0878ef49a");
    const source = { id: Long.fromString("9007199254741153"), amount: Decimal128.fromString("3.45") };
    const startDate = new Date("2000-01-01");
    const endDate = new Date("2099-01-01");
    await db.collection("freegames").insertMany([
      { id: desktop, startDate, endDate, source },
      { id: String(desktop), startDate, endDate: new Date("2005-01-01"), source },
    ]);
    await db.collection("mobile-freebies").insertMany([
      { offerId: mobile, startDate, endDate, source },
      { offerId: String(mobile), startDate, endDate: new Date("2005-01-01"), source },
    ]);
    for (const id of [String(desktop), String(mobile)]) {
      await db.collection("offers").insertOne({ id, title:"Numeric giveaway fixture", namespace:"ns-giveaway" });
      await db.collection("pricev2").insertOne({ offerId:id, region:"US", price:{currencyCode:"USD", originalPrice:Decimal128.fromString("47.50")} });
    }
    for (const [suffix, ids] of [["", [String(desktop), String(mobile)]], ["/mobile", [String(mobile)]], ["/history", [String(desktop)]]]) {
      const path = "/v1/free-games" + suffix + "?locale=fr-CA";
      const results = await Promise.all([nodeOrigin,rustOrigin].map(async origin => {
        const response = await fetch(origin + path, {headers:{
          "x-egdata-origin-token":"fixture-origin-token", "x-egdata-worker-token":"fixture-origin-token",
          "x-egdata-key-id":"key_fixture","x-egdata-key-tier":"free","x-request-id":"req_giveaway_comparison",
        }});
        assert.equal(response.status,200,origin + path);
        const body = await response.json();
        for (const id of ids) {
          const entry = body.data.find(row => row.id === id && row.giveaway.endDate === endDate.toISOString());
          assert.ok(entry, id + path);
          assert.equal(entry.giveaway.offerId, id);
          assert.equal(entry.giveaway.source.id, "9007199254741153");
          assert.equal(entry.price.originalPrice, 48);
          if (!suffix) {
            const historical = id === String(desktop) ? entry.giveaway.historical[0] : entry.giveaway.historical;
            assert.equal(historical.source.id, "9007199254741153");
          }
        }
        return {body,etag:response.headers.get("etag"),cache:response.headers.get("cache-control")};
      }));
      assert.deepEqual(results[0],results[1],path);
    }
    console.log("Current, mobile and historical giveaways matched across both listeners with seeded native BSON ids, historical records and prices.");
  } finally {
    await client.close();
  }
}

async function compareStoredRatings(nodeOrigin, rustOrigin, services) {
  const mongo = fixtureMongo(services);
  try {
    const db = mongo.db("egdata");
    const ratings = { ESRB: { rating: "T" }, PEGI: { rating: 12 } };
    for (const [id, namespace] of [
      ["ratings-object-id", new ObjectId("65ba12345678901234567123")],
      ["ratings-decimal", Decimal128.fromString("19.0")],
    ]) {
      await db.collection("offers").insertOne({ id, namespace });
      await db.collection("sandboxes").insertOne({ _id: namespace, ageGatings: ratings });
      for (const [query, expected] of [["", ratings], ["?country=US&single=true", { ESRB: ratings.ESRB }]]) {
        const path = "/v1/offers/" + id + "/age-rating" + query;
        const results = await Promise.all([nodeOrigin, rustOrigin].map(async origin => {
          const response = await fetch(origin + path, { headers: {
            "x-egdata-origin-token": "fixture-origin-token",
            "x-egdata-worker-token": "fixture-origin-token",
            "x-egdata-key-id": "key_fixture",
            "x-egdata-key-tier": "free",
            "x-request-id": "req_ratings_comparison",
          } });
          assert.equal(response.status, 200, path);
          const body = await response.json();
          assert.deepEqual(body.data, expected, path);
          return { body, etag: response.headers.get("etag") };
        }));
        assert.deepEqual(results[0], results[1], path);
      }
    }
    console.log("Both origins returned the full and country-specific age ratings for ObjectId and Decimal128 sandbox keys.");
  } finally {
    await mongo.close();
  }
}

async function checkStoredProfile(origin) {
  const headers = {
    "x-egdata-origin-token": "fixture-origin-token",
    "x-egdata-worker-token": "fixture-origin-token",
    "x-egdata-key-id": "key_fixture",
    "x-egdata-key-tier": "free",
  };
  const read = async (part) => {
    const response = await fetch(origin + "/v1/profiles/" + profileId + "/" + part, { headers });
    assert.equal(response.status, 200, part);
    return (await response.json()).data;
  };
  const [achievements, games, information, randomGame] = await Promise.all(
    ["achievements", "games", "information", "random-game"].map(read),
  );
  assert.equal(achievements.count, 1);
  assert.equal(achievements.achievements[0].displayName, "Explorer");
  assert.equal(games.achievements[0].sandboxId, "ns-oracle");
  assert.equal(information.stats.totalXP, 25);
  assert.equal(randomGame.id, "oracle-game");
}

export async function compareOrigins(
  rustDir,
  temp,
  services,
  rustOrigin,
  runOrigin,
) {
  await seedCatalog(rustDir, services);
  const root = dirname(rustDir.replace(/[\\/]$/, ""));
  run(
    process.execPath,
    [
      join(root, "node_modules/@rslib/core/bin/rslib.js"),
      "build",
      "--config",
      "rust/bench/rslib.config.mjs",
    ],
    root,
  );
  const env = {};
  for (const key of [
    "PATH",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const redis = new URL(services.EGDATA_TEST_REDIS);
  Object.assign(env, {
    NODE_ENV: "production",
    NODE_ICU_LOCALE: "en-US",
    MONGO_URL: services.EGDATA_TEST_MONGO,
    MONGO_CA: services.EGDATA_TEST_MONGO_CA,
    MONGO_CERT: services.EGDATA_TEST_MONGO_CERT,
    OPENSEARCH_URL: services.EGDATA_TEST_OPENSEARCH,
    OPENSEARCH_USERNAME: "admin",
    OPENSEARCH_PASSWORD: "Fixture-Only-Search-42!",
    REDISHOST: redis.hostname,
    REDISPORT: redis.port,
    RESPONSE_CACHE_PREFIX: "fixture:node:",
    NEON_CONNECTION_URI: services.EGDATA_TEST_PG,
    BETTER_AUTH_SECRETS: "3:fixture-origin-session-secret-used-locally,1:fixture-older-cookie-signing-secret",
    BETTER_AUTH_SECRET: "fixture-legacy-cookie-signing-secret",
    ORIGIN_AUTH_TOKEN: "fixture-origin-token",
    ORIGIN_AUTH_REQUIRED: "true",
    V1_CURSOR_SECRET: "fixture-only-shared-key-for-cross-origin-pagination",
  });
  await compareSearchMappings(root, temp, env, runOrigin);
  await Promise.all([
    indexFixture(services, "egdata.items", "indexed-item", {
      id: "indexed-item", title: "Catalogfixture", lastModifiedDate: "2026-11-17T12:00:00Z",
      metadata: { label: { $oid: "archived item reference" } },
      customAttributes: [{ key: "edition", value: { $date: "archived item edition" } }],
    }),
    indexFixture(services, "egdata.changelog", "indexed-change", {
      title: "Catalogfixture", timestamp: "2026-11-17T12:00:00Z",
      metadata: { contextType: "item", contextId: "indexed-item", label: { $oid: "archived change reference" } },
    }),
  ]);
  const module = pathToFileURL(
    join(rustDir, "target/resource-benchmark-node/origin.js"),
  ).href;
  const entry = [
    // The Node Epic client uses node-fetch's core HTTPS transport. Keep its
    // game-ownership lookup offline, as in the disposable Rust container.
    "import https from 'node:https'; import { lookup } from 'node:dns';",
    "https.globalAgent.options.lookup = (host, options, callback) => host === 'store.epicgames.com' ? callback(Object.assign(new Error('Offline fixture'), { code: 'ENOTFOUND' })) : lookup(host, options, callback);",
    "const {listen} = await import(process.argv[1]);",
    "const server = await listen(0);",
    "if (!server.listening) await new Promise(resolve => server.once('listening', resolve));",
    "process.send(server.address().port);",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", entry, module],
    {
      env,
      cwd: temp,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const exit = once(child, "exit");
  let timeout;
  try {
    const port = await Promise.race([
      once(child, "message").then(([port]) => port),
      exit.then(([code]) => {
        throw new Error("Node reference exited before listening: " + code);
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Node reference startup timed out")),
          45000,
        );
      }),
    ]);
    clearTimeout(timeout);
    await comparePrivateProfile(
      "http://127.0.0.1:" + port,
      rustOrigin,
      services,
    );
    await compareStoredMedia("http://127.0.0.1:" + port, rustOrigin);
    await compareHydration("http://127.0.0.1:" + port, rustOrigin);
    await compareItemCursors("http://127.0.0.1:" + port, rustOrigin, services);
    const cases = [
      "/v1/health",
      "/v1/countries",
      "/v1/regions",
      "/v1/countries?unknown=yes",
      "/v1/offers",
      "/v1/items",
      "/v1/sellers",
      "/v1/sandboxes",
      "/v1/offers/00000000000000000000000000000001",
      "/v1/items/00000000000000000000000000000001",
      "/countries",
      "/regions",
      "/region?country=US",
      "/tags",
      "/robots.txt",
      "/doc",
      "/ping",
    ].map((path) => ({ name: "GET " + path, method: "GET", path }));
    // Exercise documented storage-backed routes through both HTTP listeners.
    // Editorial artwork has separate rendering checks. Epic's live identity service is offline here.
    for (const file of ["egdata.openapi.json", "egdata.v1.openapi.json"]) {
      const spec = JSON.parse(
        readFileSync(join(root, "openapi", file), "utf8"),
      );
      for (const [template, methods] of Object.entries(spec.paths)) {
        const relative = template.replace(/^\/v1(?=\/)/, "");
        if (!methods.get || /\/og(?:\.webp)?$/.test(relative)) continue;
        if (/^\/(search|multisearch|health$)/.test(relative))
          continue;
        const params = {
          id: relative.startsWith("/profiles/") ? profileId
            : relative.startsWith("/offers/") ? "oracle-game" : "000000000000000000000001",
          namespace: "ns-oracle",
          sandboxId: "ns-oracle",
          targetId: "000000000000000000000001",
          baseId: "000000000000000000000002",
          slug: "fixture",
          week: "1",
          collection: "fixture",
        };
        const path = template.replace(/\{([^}]+)\}/g, (_, name) => {
          if (!Object.hasOwn(params, name))
            throw new Error("Missing catalog fixture parameter " + name);
          return params[name];
        });
        if (!cases.some((c) => c.path === path))
          cases.push({ name: "GET " + path, method: "GET", path });
      }
    }
    const readBodies = {
      "/offers/slugs": { slugs: ["oracle-game"] },
      "/offers/exists": { offers: ["oracle-game"] },
      "/items/bulk": { items: ["fixture"] },
      "/items/bulk/offers": { items: ["fixture"] },
      "/builds/resolve-launcher-records": {
        candidates: [
          {
            requestId: "fixture",
            buildAppName: "fixture",
            buildVersion: "1",
            platform: "Windows",
          },
        ],
      },
      "/catalog/hydrate": {
        schemaVersion: 2,
        identifiers: [{ type: "item", namespace: "ns-oracle", id: "fixture" }],
      },
    };
    for (const prefix of ["", "/v1"]) {
      for (const [suffix, body] of Object.entries(readBodies)) {
        const path = prefix + suffix;
        cases.push({ name: "POST " + path, method: "POST", path, body });
      }
    }
    const localizedPath = "/v1/offers/oracle-game?country=US&locale=es-ES";
    const localized = await fetch("http://127.0.0.1:" + port + localizedPath, {
      headers: {
        "x-egdata-origin-token": "fixture-origin-token",
        "x-egdata-worker-token": "fixture-origin-token",
        "x-egdata-key-id": "key_fixture",
        "x-egdata-key-tier": "free",
      },
    });
    const offer = await localized.json();
    if (localized.status !== 200 || offer.data?.title !== "Juego Oráculo")
      throw new Error(
        "Expected a localized catalog response, got " +
          localized.status +
          " " +
          (offer.code ?? offer.data?.title),
      );
    cases.push({
      name: "localized priced offer",
      method: "GET",
      path: localizedPath,
    });
    const itemOfferPath = "/v1/items/fixture/offer?country=US";
    const itemOfferResponse = await fetch("http://127.0.0.1:" + port + itemOfferPath, {
      headers: {
        "x-egdata-origin-token": "fixture-origin-token", "x-egdata-worker-token": "fixture-origin-token",
        "x-egdata-key-id": "key_fixture", "x-egdata-key-tier": "free",
      },
    });
    assert.equal(itemOfferResponse.status, 200);
    const itemOffer = await itemOfferResponse.json();
    assert.equal(itemOffer.data.id, "regional-price-fixture");
    assert.equal(itemOffer.data.price.discountPrice, 350);
    cases.push({ name: "item offer latest stored regional price", method: "GET", path: itemOfferPath });
    for (const expand of [false, true]) {
      const path = "/game-awards?locale=es-ES&expand=" + expand;
      const response = await fetch("http://127.0.0.1:" + port + path, {
        headers: { "x-egdata-origin-token": "fixture-origin-token" },
      });
      assert.equal(response.status, 200);
      const modules = await response.json();
      assert.deepEqual(modules.map((group) => group.title), ["Archived", "Nominated"]);
      assert.equal(modules[1].offers[0].title, "Juego Oráculo");
      cases.push({ name: "localized Game Awards groups expand=" + expand, method: "GET", path });
    }
    for (const [name, accept] of [
      ["callback", "application/json;callbackSpec=1.0"],
      ["preference", "application/json;q=0.9001, application/graphql-response+json;q=0.9002"],
      ["unavailable charset", "application/json;charset=latin1"],
    ]) {
      cases.push({ name: "GraphQL media " + name, method: "POST", path: "/graphql", headers: { accept }, body: { query: "{__typename}" } });
    }
    cases.push({
      name: "GraphQL anonymous typename",
      method: "POST",
      path: "/graphql",
      body: { query: "{ __typename }" },
    });
    const profileBody = { query: profileQuery, variables: { id: profileId } };
    const profileResponse = await fetch(
      "http://127.0.0.1:" + port + "/graphql",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-egdata-origin-token": "fixture-origin-token",
        },
        body: JSON.stringify(profileBody),
      },
    );
    const profile = await profileResponse.json();
    assert.equal(profileResponse.status, 200);
    assert.deepEqual(profile.errors, undefined);
    assert.equal(
      profile.data.profile.achievements.elements[0].displayName,
      "Explorer",
    );
    assert.equal(profile.data.profile.games.elements[0].sandboxId, "ns-oracle");
    cases.push({
      name: "GraphQL stored profile achievements and activity",
      method: "POST",
      path: "/graphql",
      body: profileBody,
    });
    for (const c of cases) {
      c.headers = {
        ...c.headers,
        "x-egdata-request-id": "627d17fe-4949-4ef0-9bee-ad9e56395224",
      };
    }
    const searchPath = "/v1/search?title=Oracle&limit=1&facets=none";
    const searchHeaders = {
      "x-egdata-origin-token": "fixture-origin-token",
      "x-egdata-worker-token": "fixture-origin-token",
      "x-egdata-key-id": "key_fixture",
      "x-egdata-key-tier": "free",
    };
    await Promise.all(["http://127.0.0.1:" + port, rustOrigin].map(async origin => {
      const response = await fetch(origin + searchPath, { headers: searchHeaders });
      assert.equal(response.status, 200, origin + searchPath);
      const payload = await response.json();
      const hit = payload.data.find(offer => offer.id === "oracle-game");
      assert.ok(hit, "authenticated OpenSearch title lookup");
      assert.deepEqual(hit.keyImages[0].metadata, { $oid: "archived image reference" });
      assert.equal(hit.price.price.discountPrice, 350);
      assert.deepEqual(hit.price.price.metadata, { $date: "archived price" });
    }));
    cases.push({ name: "authenticated OpenSearch title lookup", method: "GET", path: searchPath });
    for (const path of ["/v1/collections/ranked-fixture", "/v1/collections/ranked-fixture/2025W29"]) {
      for (const origin of ["http://127.0.0.1:" + port, rustOrigin]) {
        const response = await fetch(origin + path, { headers: searchHeaders });
        assert.equal(response.status, 200, path);
        const { data, meta } = await response.json();
        assert.equal(meta.title, "Ranked,2025");
        assert.equal(data.length, 1);
        assert.equal(data[0].price.price.discountPrice, 350);
        assert.deepEqual(data[0].previousPosition, { $numberDecimal: "2.5" });
        assert.deepEqual(data[0].metadata.positions[0].metadata, { $oid: "literal" });
      }
      cases.push({ name: "native Mongo rank " + path, method: "GET", path });
    }
    for (const [name, path, expected] of [
      ["indexed item with literal metadata", "/v1/multisearch/items?query=Catalogfixture", "archived item reference"],
      ["indexed change with literal metadata", "/v1/search/changelog?query=Catalogfixture", "archived change reference"],
    ]) {
      await Promise.all(["http://127.0.0.1:" + port, rustOrigin].map(async origin => {
        const response = await fetch(origin + path, { headers: searchHeaders });
        assert.equal(response.status, 200, origin + path);
        const { data } = await response.json();
        assert.equal(data.length, 1, path);
        assert.deepEqual(data[0].metadata.label, { $oid: expected });
      }));
      cases.push({ name, method: "GET", path });
    }
    const fixtures = join(temp, "http-cases.json");
    writeFileSync(fixtures, JSON.stringify(cases));
    run(
      "cargo",
      [
        "run",
        "--locked",
        "-p",
        "egdata-diff",
        "--",
        "--node-url",
        "http://127.0.0.1:" + port,
        "--rust-url",
        rustOrigin,
        "--origin-token",
        "fixture-origin-token",
        "--worker-token",
        "fixture-origin-token",
        "--key-id",
        "key_fixture",
        "--key-tier",
        "free",
        "--fixtures",
        fixtures,
      ],
      rustDir,
    );
    await compareStoredRatings("http://127.0.0.1:" + port, rustOrigin, services);
    await compareLegacyPagination("http://127.0.0.1:" + port, rustOrigin, services);
    await compareStoredGiveaways("http://127.0.0.1:" + port, rustOrigin, services);
    await Promise.all(["http://127.0.0.1:" + port, rustOrigin].map(checkStoredProfile));
    console.log("Both origins returned the seeded achievement, game, experience and random offer through the public profile API.");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exit;
      } finally {
        clearTimeout(force);
      }
    }
  }
}
