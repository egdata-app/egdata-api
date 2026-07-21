import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { Asset, Item, Offer } from "../models/index.js";
import { attributesToObject } from "../utils/attributes-to-object.js";

type CatalogDocument = Record<string, unknown>;

const hintSchema = z
  .object({
    artifactId: z.string().trim().min(1).max(256),
    catalogItemId: z.string().trim().min(1).max(256),
    catalogNamespace: z.string().trim().min(1).max(256),
  })
  .strict();

const candidateSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    buildAppName: z.string().trim().min(1).max(256),
    buildVersion: z.string().trim().max(512),
    platform: z.literal("Windows"),
    catalogHint: hintSchema.optional(),
  })
  .strict();

export const launcherRecordResolveRequestSchema = z
  .object({
    candidates: z.array(candidateSchema).min(1).max(100),
  })
  .strict()
  .refine(
    ({ candidates }) =>
      new Set(candidates.map((candidate) => candidate.requestId)).size ===
      candidates.length,
    "requestId values must be unique",
  );

type Candidate = z.infer<typeof candidateSchema>;

interface LauncherIdentity {
  artifactId: string;
  catalogItemId: string;
  catalogNamespace: string;
}

interface LauncherRecord extends LauncherIdentity {
  displayName: string;
  kind: "base-game" | "addon" | "digital-extra";
  appCategories: string[];
  mainGame: LauncherIdentity | null;
  mandatoryAppFolderName: string;
  canRunOffline: boolean;
  requiresAuth: boolean;
  ownershipToken: boolean;
  ignoredProcessNames: string[];
}

export type LauncherRecordResolveResult =
  | { requestId: string; status: "resolved"; record: LauncherRecord }
  | { requestId: string; status: "not-found" | "ambiguous" | "unsupported" };

function documentValue(document: unknown): CatalogDocument {
  if (!document || typeof document !== "object" || Array.isArray(document))
    return {};
  const value = document as CatalogDocument;
  if (typeof value.toObject !== "function") return value;
  const decoded: unknown = value.toObject();
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as CatalogDocument)
    : {};
}

function attributeValue(attributes: CatalogDocument, key: string): unknown {
  const value = attributes[key];
  if (value && typeof value === "object" && "value" in value)
    return value.value;
  return value;
}

function booleanAttribute(
  attributes: CatalogDocument,
  key: string,
  fallback: boolean,
): boolean {
  const value = attributeValue(attributes, key);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function stringAttribute(attributes: CatalogDocument, key: string): string {
  const value = attributeValue(attributes, key);
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayAttribute(
  attributes: CatalogDocument,
  key: string,
): string[] {
  const value = attributeValue(attributes, key);
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      );
    }
  } catch {
    // Epic also stores some process lists as comma-delimited strings.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function categoryPaths(item: CatalogDocument): string[] {
  if (!Array.isArray(item.categories)) return [];
  return item.categories
    .map((category: unknown) => {
      if (typeof category === "string") return category;
      if (category && typeof category === "object" && "path" in category) {
        const path = (category as { path?: unknown }).path;
        return typeof path === "string" ? path : "";
      }
      return "";
    })
    .filter(Boolean)
    .map((path) => path.toLowerCase());
}

function classifyItem(
  item: CatalogDocument,
  offers: CatalogDocument[],
): LauncherRecord["kind"] | null {
  const paths = categoryPaths(item);
  if (paths.some((path) => path.includes("digitalextra")))
    return "digital-extra";
  if (offers.some((offer) => offer.offerType === "DLC")) return "addon";
  if (paths.some((path) => path.includes("addon") || path.includes("dlc")))
    return "addon";
  if (offers.some((offer) => offer.offerType === "BASE_GAME"))
    return "base-game";
  if (item.entitlementType === "EXECUTABLE" && item.itemType !== "DURABLE")
    return "base-game";
  return null;
}

function categoriesFor(kind: LauncherRecord["kind"]): string[] {
  if (kind === "base-game") return ["public", "games", "applications"];
  if (kind === "digital-extra") return ["digitalextras", "applications"];
  return ["addons"];
}

async function windowsAssetsForItem(
  itemId: string,
): Promise<CatalogDocument[]> {
  const assets = await Asset.find({ itemId: { $eq: itemId } });
  return assets
    .map(documentValue)
    .filter(
      (asset) => String(asset.platform ?? "").toLowerCase() === "windows",
    );
}

async function identityForItem(
  item: CatalogDocument,
  preferredArtifactId?: string,
): Promise<LauncherIdentity | null | "ambiguous"> {
  const assets = await windowsAssetsForItem(String(item.id ?? ""));
  const selected = preferredArtifactId
    ? assets.filter((asset) => asset.artifactId === preferredArtifactId)
    : assets;
  if (preferredArtifactId && selected.length === 0) return null;
  if (selected.length > 1) return "ambiguous";
  const asset = selected[0];
  const artifactId = preferredArtifactId || String(asset?.artifactId ?? "");
  const catalogItemId = String(item.id ?? "");
  const catalogNamespace = String(item.namespace ?? "");
  if (!artifactId || !catalogItemId || !catalogNamespace) return null;
  return { artifactId, catalogItemId, catalogNamespace };
}

async function offersForItem(itemId: string): Promise<CatalogDocument[]> {
  const direct = await Offer.find({
    "items.id": { $eq: itemId },
    offerType: { $in: ["BASE_GAME", "DLC"] },
  });
  const subItems = await db.db
    .collection<{ _id: string }>("offersubitems")
    .find({ "subItems.id": { $eq: itemId } }, { projection: { _id: 1 } })
    .toArray();
  const indirect = subItems.length
    ? await Offer.find({
        id: { $in: subItems.map((entry) => entry._id) },
        offerType: { $in: ["BASE_GAME", "DLC"] },
      })
    : [];
  const byId = new Map<string, CatalogDocument>();
  for (const offer of [...direct, ...indirect].map(documentValue)) {
    const id = String(offer.id ?? offer._id ?? "");
    if (id) byId.set(id, offer);
  }
  return [...byId.values()];
}

async function mainGameIdentity(
  item: CatalogDocument,
  offers: CatalogDocument[],
): Promise<LauncherIdentity | null | "ambiguous"> {
  const baseOffers = offers.filter((offer) => offer.offerType === "BASE_GAME");
  if (baseOffers.length !== 1)
    return baseOffers.length > 1 ? "ambiguous" : null;
  const itemIds = Array.isArray(baseOffers[0]?.items)
    ? baseOffers[0].items
        .map((entry: unknown) =>
          entry && typeof entry === "object" && "id" in entry
            ? String((entry as { id: unknown }).id)
            : "",
        )
        .filter(Boolean)
    : [];
  const baseItems = (await Item.find({ id: { $in: itemIds } }))
    .map(documentValue)
    .filter((candidate) => candidate.id !== item.id);
  const executable = baseItems.filter(
    (candidate) => candidate.entitlementType === "EXECUTABLE",
  );
  const choices = executable.length ? executable : baseItems;
  if (choices.length !== 1) return choices.length > 1 ? "ambiguous" : null;
  return identityForItem(choices[0]);
}

async function candidateItems(
  candidate: Candidate,
): Promise<CatalogDocument[]> {
  if (candidate.catalogHint) {
    return (
      await Item.find({
        id: { $eq: candidate.catalogHint.catalogItemId },
        namespace: { $eq: candidate.catalogHint.catalogNamespace },
      })
    ).map(documentValue);
  }
  return (
    await Item.find({
      releaseInfo: {
        $elemMatch: {
          appId: { $eq: candidate.buildAppName },
          platform: { $regex: /^Win/i },
        },
      },
    })
  ).map(documentValue);
}

export async function resolveLauncherRecord(
  candidate: Candidate,
): Promise<LauncherRecordResolveResult> {
  const items = await candidateItems(candidate);
  if (items.length === 0)
    return { requestId: candidate.requestId, status: "not-found" };
  if (items.length > 1)
    return { requestId: candidate.requestId, status: "ambiguous" };

  const item = items[0];
  const identity = await identityForItem(
    item,
    candidate.catalogHint?.artifactId,
  );
  if (identity === "ambiguous")
    return { requestId: candidate.requestId, status: "ambiguous" };
  if (!identity)
    return { requestId: candidate.requestId, status: "unsupported" };

  const offers = await offersForItem(identity.catalogItemId);
  const kind = classifyItem(item, offers);
  if (!kind) return { requestId: candidate.requestId, status: "unsupported" };

  let mainGame: LauncherIdentity | null = null;
  if (kind !== "base-game") {
    const parent = await mainGameIdentity(item, offers);
    if (parent === "ambiguous")
      return { requestId: candidate.requestId, status: "ambiguous" };
    if (!parent)
      return { requestId: candidate.requestId, status: "unsupported" };
    mainGame = parent;
  }

  const customAttributes = [
    ...(Array.isArray(item.customAttributes) ? item.customAttributes : []),
    ...offers.flatMap((offer) =>
      Array.isArray(offer.customAttributes) ? offer.customAttributes : [],
    ),
  ];
  const normalizedAttributes = customAttributes.flatMap((attribute) => {
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute))
      return [];
    const value = attribute as CatalogDocument;
    if (typeof value.key !== "string" || typeof value.value !== "string")
      return [];
    return [
      {
        key: value.key,
        value: value.value,
        ...(typeof value.type === "string" ? { type: value.type } : {}),
      },
    ];
  });
  const attributes = normalizedAttributes.length
    ? attributesToObject(normalizedAttributes)
    : {};
  return {
    requestId: candidate.requestId,
    status: "resolved",
    record: {
      ...identity,
      displayName: String(item.title ?? identity.artifactId),
      kind,
      appCategories: categoriesFor(kind),
      mainGame,
      mandatoryAppFolderName: stringAttribute(attributes, "FolderName"),
      canRunOffline: booleanAttribute(attributes, "CanRunOffline", true),
      requiresAuth: booleanAttribute(attributes, "RequiresAuth", true),
      ownershipToken: booleanAttribute(attributes, "OwnershipToken", false),
      ignoredProcessNames: stringArrayAttribute(
        attributes,
        "IgnoredProcessNames",
      ),
    },
  };
}

const app = new Hono();

app.post("/resolve-launcher-records", async (c) => {
  const decoded: unknown = await c.req.json().catch(() => null);
  const parsed = launcherRecordResolveRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid launcher record request",
        },
      },
      400,
    );
  }

  const results: LauncherRecordResolveResult[] = [];
  for (const candidate of parsed.data.candidates) {
    results.push(await resolveLauncherRecord(candidate));
  }
  return c.json({ results });
});

export default app;
