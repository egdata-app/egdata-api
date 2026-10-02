import { db } from "../db/index.js";

export type RequirementsPlatform = "windows" | "macos";

type RequirementTier = Record<string, unknown>;

type OfferRequirementsDocument = {
  namespace: string;
  offerId: string;
  platform: RequirementsPlatform;
  offerType: "BASE_GAME" | "DLC";
  source: {
    sourceType:
      | "product_page"
      | "store_configuration"
      | "confirmed_absent"
      | "inherited";
    observedAt: Date;
    rawRows: unknown[];
  };
  processing: {
    sourceGeneration: number;
    state:
      | "pending"
      | "in_progress"
      | "normalized"
      | "inherited"
      | "empty"
      | "stale"
      | "failed"
      | "unknown";
  };
  parent?: {
    parentNamespace: string | null;
    parentOfferId: string | null;
    relationshipType: string | null;
    resolvedInheritance: boolean;
  };
  requirements: {
    minimum: RequirementTier | null;
    recommended: RequirementTier | null;
  };
};

export type ResolvedOfferRequirements = {
  namespace: string;
  offerId: string;
  platform: RequirementsPlatform;
  offerType: "BASE_GAME" | "DLC";
  inherited: boolean;
  isInherited: boolean;
  parentOfferId: string | null;
  parent: {
    namespace: string | null;
    offerId: string | null;
    relationshipType: string | null;
  } | null;
  state: OfferRequirementsDocument["processing"]["state"];
  sourceGeneration: number;
  observedAt: Date;
  requirements: {
    minimum: RequirementTier | null;
    recommended: RequirementTier | null;
  };
};

async function getRequirementsDocument(
  namespace: string,
  offerId: string,
  platform: RequirementsPlatform,
): Promise<OfferRequirementsDocument | null> {
  return db.db
    .collection<OfferRequirementsDocument>("offer_requirements")
    .findOne({ namespace, offerId, platform });
}

/** Resolve current requirements, dynamically following a validated DLC parent. */
export async function resolveOfferRequirements(
  namespace: string,
  offerId: string,
  platform: RequirementsPlatform,
): Promise<ResolvedOfferRequirements | null> {
  const ownDoc = await getRequirementsDocument(namespace, offerId, platform);
  if (!ownDoc) return null;

  const hasOwnRequirements = Boolean(
    ownDoc.requirements?.minimum || ownDoc.requirements?.recommended,
  );
  const ownParentOfferId = ownDoc.parent?.parentOfferId ?? null;
  const ownParentNamespace = ownDoc.parent?.parentNamespace ?? ownDoc.namespace;

  if (hasOwnRequirements) {
    return {
      namespace: ownDoc.namespace,
      offerId: ownDoc.offerId,
      platform: ownDoc.platform,
      offerType: ownDoc.offerType,
      inherited: false,
      isInherited: false,
      parentOfferId: ownParentOfferId,
      parent: ownParentOfferId
        ? {
            namespace: ownParentNamespace,
            offerId: ownParentOfferId,
            relationshipType: ownDoc.parent?.relationshipType ?? null,
          }
        : null,
      state: ownDoc.processing.state,
      sourceGeneration: ownDoc.processing.sourceGeneration,
      observedAt: ownDoc.source.observedAt,
      requirements: ownDoc.requirements,
    };
  }

  if (ownDoc.offerType !== "DLC") {
    return {
      namespace: ownDoc.namespace,
      offerId: ownDoc.offerId,
      platform: ownDoc.platform,
      offerType: ownDoc.offerType,
      inherited: false,
      isInherited: false,
      parentOfferId: null,
      parent: null,
      state: ownDoc.processing.state,
      sourceGeneration: ownDoc.processing.sourceGeneration,
      observedAt: ownDoc.source.observedAt,
      requirements: ownDoc.requirements,
    };
  }

  if (
    ownDoc.processing.state === "failed" ||
    ownDoc.processing.state === "stale"
  ) {
    return {
      namespace: ownDoc.namespace,
      offerId: ownDoc.offerId,
      platform: ownDoc.platform,
      offerType: ownDoc.offerType,
      inherited: false,
      isInherited: false,
      parentOfferId: null,
      parent: null,
      state: ownDoc.processing.state,
      sourceGeneration: ownDoc.processing.sourceGeneration,
      observedAt: ownDoc.source.observedAt,
      requirements: { minimum: null, recommended: null },
    };
  }

  const parentDoc = ownParentOfferId
    ? await getRequirementsDocument(
        ownParentNamespace,
        ownParentOfferId,
        platform,
      )
    : null;
  const canInherit = Boolean(
    ownDoc.source.sourceType === "confirmed_absent" &&
      ownDoc.source.rawRows.length === 0 &&
      ownDoc.parent?.resolvedInheritance &&
      ownDoc.parent.relationshipType &&
      parentDoc?.offerType === "BASE_GAME" &&
      parentDoc.offerId === ownParentOfferId &&
      parentDoc.namespace === ownParentNamespace &&
      parentDoc.platform === ownDoc.platform &&
      (parentDoc.processing.state === "normalized" ||
        parentDoc.processing.state === "stale") &&
      (parentDoc.requirements.minimum || parentDoc.requirements.recommended),
  );

  if (!canInherit || !parentDoc || !ownParentOfferId) {
    return {
      namespace: ownDoc.namespace,
      offerId: ownDoc.offerId,
      platform: ownDoc.platform,
      offerType: ownDoc.offerType,
      inherited: false,
      isInherited: false,
      parentOfferId: ownParentOfferId,
      parent: ownParentOfferId
        ? {
            namespace: ownParentNamespace,
            offerId: ownParentOfferId,
            relationshipType: ownDoc.parent?.relationshipType ?? null,
          }
        : null,
      state: "unknown",
      sourceGeneration: ownDoc.processing.sourceGeneration,
      observedAt: ownDoc.source.observedAt,
      requirements: { minimum: null, recommended: null },
    };
  }

  return {
    namespace: ownDoc.namespace,
    offerId: ownDoc.offerId,
    platform: ownDoc.platform,
    offerType: ownDoc.offerType,
    inherited: true,
    isInherited: true,
    parentOfferId: ownParentOfferId,
    parent: {
      namespace: ownParentNamespace,
      offerId: ownParentOfferId,
      relationshipType: ownDoc.parent?.relationshipType ?? null,
    },
    state: parentDoc.processing.state === "stale" ? "stale" : "inherited",
    sourceGeneration: ownDoc.processing.sourceGeneration,
    observedAt: parentDoc.source.observedAt,
    requirements: parentDoc.requirements,
  };
}
