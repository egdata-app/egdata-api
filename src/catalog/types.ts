export type CatalogImage = { type: string; url: string; md5?: string };
export type CatalogTag = { id: string; name?: string };
export type CatalogCustomAttribute = {
  key: string;
  value: string;
  type?: string;
};

export type CatalogOfferRecord = {
  type: "offer";
  namespace: string;
  id: string;
  title: string;
  description?: string;
  longDescription?: string;
  offerType?: string;
  seller?: { id: string; name: string };
  developerDisplayName?: string;
  publisherDisplayName?: string;
  productSlug?: string;
  urlSlug?: string;
  url?: string;
  keyImages: CatalogImage[];
  tags: CatalogTag[];
  categories: string[];
  customAttributes: CatalogCustomAttribute[];
  effectiveDate?: string;
  creationDate?: string;
  lastModifiedDate?: string;
  releaseDate?: string;
  pcReleaseDate?: string;
  viewableDate?: string;
  prePurchase?: boolean;
  isCodeRedemptionOnly?: boolean;
  countriesBlacklist: string[];
  countriesWhitelist: string[];
  refundType?: string;
  offerMappings: Array<{ pageSlug: string; pageType: string }>;
};

export type CatalogItemRecord = {
  type: "item";
  namespace: string;
  id: string;
  title: string;
  description?: string;
  longDescription?: string;
  technicalDetails?: string;
  status?: string;
  entitlementName?: string;
  entitlementType?: string;
  itemType?: string;
  keyImages: CatalogImage[];
  categories: string[];
  customAttributes: CatalogCustomAttribute[];
  creationDate?: string;
  lastModifiedDate?: string;
  developer?: string;
  developerId?: string;
  eulaIds: string[];
  installModes: string[];
  endOfSupport?: boolean;
  selfRefundable?: boolean;
  applicationId?: string;
  unsearchable?: boolean;
  requiresSecureAccount?: boolean;
  entitlementStartDate?: string;
  entitlementEndDate?: string;
  useCount?: number;
  primaryOfferNamespace?: string;
  primaryOfferId?: string;
};

export type CatalogAssetRecord = {
  type: "asset";
  namespace: string;
  artifactId: string;
  platform: string;
  itemNamespace: string;
  itemId: string;
  downloadSizeBytes?: number;
  installedSizeBytes?: number;
  primaryOfferNamespace?: string;
  primaryOfferId?: string;
};

export type CatalogReleaseAppRecord = {
  type: "release-app";
  namespace: string;
  appId: string;
  platform: string;
  itemNamespace: string;
  itemId: string;
  releaseId?: string;
  primaryOfferNamespace?: string;
  primaryOfferId?: string;
};

export type CatalogOfferItemSource = "direct" | "subitem" | "linked";
export type CatalogOfferItemRecord = {
  type: "offer-item";
  offerNamespace: string;
  offerId: string;
  itemNamespace: string;
  itemId: string;
  sources: CatalogOfferItemSource[];
  isPrimary: boolean;
};

export type CatalogRecord =
  | CatalogOfferRecord
  | CatalogItemRecord
  | CatalogAssetRecord
  | CatalogReleaseAppRecord
  | CatalogOfferItemRecord;
