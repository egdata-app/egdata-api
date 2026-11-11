import type { V1OperationMetadata } from "../route-types.js";
import { assetsOperations } from "./assets.js";
import { buildsOperations } from "./builds.js";
import { catalogOperations } from "./catalog.js";
import { collectionsOperations } from "./collections.js";
import { franchisesOperations } from "./franchises.js";
import { freeGamesOperations } from "./free-games.js";
import { gameAwardsOperations } from "./game-awards.js";
import { itemsOperations } from "./items.js";
import { multisearchOperations } from "./multisearch.js";
import { nativeOperations } from "./native.js";
import { offerDetailsOperations } from "./offer-details.js";
import { offersOperations } from "./offers.js";
import { ogOperations } from "./og.js";
import { profilesOperations } from "./profiles.js";
import { promotionsOperations } from "./promotions.js";
import { sandboxesOperations } from "./sandboxes.js";
import { searchOperations } from "./search.js";
import { sellersOperations } from "./sellers.js";
import { statsOperations } from "./stats.js";
import { systemOperations } from "./system.js";

export const v1Operations: readonly V1OperationMetadata[] = [
  ...systemOperations,
  ...catalogOperations,
  ...offersOperations,
  ...offerDetailsOperations,
  ...searchOperations,
  ...multisearchOperations,
  ...nativeOperations,
  ...ogOperations,
  ...itemsOperations,
  ...sellersOperations,
  ...sandboxesOperations,
  ...buildsOperations,
  ...freeGamesOperations,
  ...promotionsOperations,
  ...collectionsOperations,
  ...profilesOperations,
  ...statsOperations,
  ...franchisesOperations,
  ...gameAwardsOperations,
  ...assetsOperations,
];

const operationIds = new Set<string>();
const operationKeys = new Set<string>();
for (const operation of v1Operations) {
  if (operationIds.has(operation.operationId)) {
    throw new Error(`Duplicate v1 operationId: ${operation.operationId}`);
  }
  operationIds.add(operation.operationId);
  const key = `${operation.method} ${operation.path}`;
  if (operationKeys.has(key)) {
    throw new Error(`Duplicate v1 operation: ${key}`);
  }
  operationKeys.add(key);
}

export const v1OperationsByLegacyPath = (): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const operation of v1Operations) {
    for (const legacy of operation.legacy ?? []) {
      const entries = map.get(legacy) ?? [];
      entries.push(operation.operationId);
      map.set(legacy, entries);
    }
  }
  return map;
};

export const v1PublicOperations = v1Operations.filter(
  (operation) =>
    operation.responseKind !== "image" && operation.responseKind !== "xml",
);
