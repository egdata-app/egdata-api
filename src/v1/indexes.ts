import type { Db, IndexSpecification } from "mongodb";
import { consola } from "../utils/logger.js";

type IndexPlan = {
  collection: string;
  keys: IndexSpecification;
  name: string;
};

/**
 * Indexes required by v1 keyset scans and detail lookups. They are additive and
 * safe to create while legacy routes continue serving traffic.
 */
const INDEX_PLAN: IndexPlan[] = [
  { collection: "offers", keys: { id: 1 }, name: "v1_offer_id" },
  {
    collection: "offers",
    keys: { lastModifiedDate: -1, id: 1 },
    name: "v1_offer_last_modified_id",
  },
  {
    collection: "offers",
    keys: { releaseDate: 1, id: 1 },
    name: "v1_offer_release_id",
  },
  {
    collection: "offers",
    keys: { releaseDate: -1, id: 1 },
    name: "v1_offer_release_desc_id",
  },
  {
    collection: "offers",
    keys: { creationDate: -1, id: 1 },
    name: "v1_offer_creation_desc_id",
  },
  {
    collection: "offers",
    keys: { "tags.id": 1 },
    name: "v1_offer_tags",
  },
  {
    collection: "offers",
    keys: { namespace: 1, offerType: 1 },
    name: "v1_offer_namespace_type",
  },
  {
    collection: "offers",
    keys: { "seller.id": 1, lastModifiedDate: -1, id: 1 },
    name: "v1_offer_seller_modified",
  },
  { collection: "items", keys: { id: 1 }, name: "v1_item_id" },
  {
    collection: "items",
    keys: { lastModifiedDate: -1, id: 1 },
    name: "v1_item_modified_id",
  },
  {
    collection: "items",
    keys: { namespace: 1, lastModifiedDate: -1, id: 1 },
    name: "v1_item_namespace_modified",
  },
  {
    collection: "offers",
    keys: { namespace: 1, lastModifiedDate: -1, id: 1 },
    name: "v1_offer_namespace_modified",
  },
  {
    collection: "offers",
    keys: { "tags.id": 1, lastModifiedDate: -1, id: 1 },
    name: "v1_offer_tag_modified",
  },
  {
    collection: "changelogs_v2",
    keys: { "metadata.contextType": 1, timestamp: -1 },
    name: "v1_changelog_type_timestamp",
  },
  {
    collection: "pricev2",
    keys: { region: 1, offerId: 1, updatedAt: -1 },
    name: "v1_price_region_offer_updated",
  },
  {
    collection: "pricev2",
    keys: { region: 1, "appliedRules.endDate": 1, offerId: 1 },
    name: "v1_price_region_sale_end",
  },
  {
    collection: "pricev2_historical",
    keys: { offerId: 1, region: 1, date: -1 },
    name: "v1_price_history_offer_region_date",
  },
  {
    collection: "pricev2_historical",
    keys: { offerId: 1, region: 1, "price.discountPrice": 1 },
    name: "v1_price_history_offer_region_price",
  },
  {
    collection: "changelogs_v2",
    keys: { timestamp: -1, _id: 1 },
    name: "v1_changelog_timestamp_id",
  },
  {
    collection: "changelogs_v2",
    keys: { "metadata.contextId": 1, timestamp: -1 },
    name: "v1_changelog_context_timestamp",
  },
  {
    collection: "tags",
    keys: { groupName: 1, status: 1 },
    name: "v1_tag_group_status",
  },
  {
    collection: "tags",
    keys: { updated: -1, id: 1 },
    name: "v1_tag_updated_id",
  },
  {
    collection: "tags",
    keys: { groupName: 1, referenceCount: -1 },
    name: "v1_tag_group_reference",
  },
  {
    collection: "freegames",
    keys: { endDate: -1, id: -1 },
    name: "v1_freegame_end_id",
  },
  { collection: "freegames", keys: { id: 1 }, name: "v1_freegame_id" },
  {
    collection: "mobile-freebies",
    keys: { endDate: -1, offerId: 1 },
    name: "v1_mobile_freebie_end_offer",
  },
  {
    collection: "game_positions",
    keys: { collectionId: 1, position: 1, offerId: 1 },
    name: "v1_position_collection_rank",
  },
  {
    collection: "game_positions",
    keys: { offerId: 1 },
    name: "v1_position_offer",
  },
  {
    collection: "builds",
    keys: { appName: 1, updatedAt: -1 },
    name: "v1_build_app_updated",
  },
  {
    collection: "builds",
    keys: { appName: 1, firstSeenAt: -1, _id: -1 },
    name: "v1_build_app_history",
  },
  {
    collection: "builds",
    keys: { createdAt: 1, _id: 1 },
    name: "v1_build_created",
  },
  {
    collection: "files",
    keys: { fileName: 1 },
    name: "v1_file_name",
  },
  {
    collection: "files",
    keys: { manifestHash: 1, fileName: 1 },
    name: "v1_file_manifest_name",
  },
  {
    collection: "files",
    keys: { manifestId: 1, fileName: 1 },
    name: "v1_file_manifest_id_name",
  },
  {
    collection: "sandboxes",
    keys: { lastModified: -1 },
    name: "v1_sandbox_modified",
  },
  {
    collection: "namespaces",
    keys: { _id: 1 },
    name: "v1_namespace_id",
  },
  {
    collection: "sellers",
    keys: { _id: 1 },
    name: "v1_seller_id",
  },
  {
    collection: "collections_v2",
    keys: { _id: 1 },
    name: "v1_collection_id",
  },
  {
    collection: "reviews",
    keys: { id: 1, createdAt: -1, _id: -1 },
    name: "v1_review_offer_created",
  },
  {
    collection: "offersubitems",
    keys: { _id: 1 },
    name: "v1_offer_subitems_id",
  },
  {
    collection: "offer_requirements",
    keys: { namespace: 1, offerId: 1, platform: 1 },
    name: "v1_offer_requirements",
  },
];

let ensured = false;

export async function ensureV1Indexes(
  db: Db,
  options: { force?: boolean } = {},
): Promise<{ created: number; failed: number }> {
  if (ensured && !options.force) return { created: 0, failed: 0 };
  let created = 0;
  let failed = 0;

  for (const plan of INDEX_PLAN) {
    try {
      await db
        .collection(plan.collection)
        .createIndex(plan.keys, { name: plan.name, background: true });
      created++;
    } catch (error) {
      failed++;
      consola.warn(
        `[v1] Could not create index ${plan.collection}.${plan.name}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  ensured = true;
  consola.info(
    `[v1] Index plan checked (${created} ensured, ${failed} failed)`,
  );
  return { created, failed };
}

export const v1IndexPlan = INDEX_PLAN;
