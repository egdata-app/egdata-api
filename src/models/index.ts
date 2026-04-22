import { db } from "../db/index.js";
import { createMongoModel } from "./mongo-model.js";

export type OfferType = Record<string, any>;
export type PriceEngineType = Record<string, any>;
export type ChangelogType = Record<string, any>;

export interface IUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  epicId: string | null;
  registrationDate: Date;
}

export interface IPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  topics: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IGoogleAuth {
  _id: string;
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_at: Date;
  refresh_expires_at: Date;
  scope: string;
  token_type: string;
  created_at: Date;
}

export interface IReview {
  id: string;
  userId: string;
  rating: number;
  recommended: boolean;
  content: unknown;
  title: string;
  tags: string[];
  createdAt: Date;
  verified: boolean;
  updatedAt: Date;
  editions?: Array<{
    title: string;
    content: unknown;
    createdAt: Date;
    rating: number;
    tags: string[];
    recommended: boolean;
  }>;
}

export const AchievementSet = createMongoModel<Document>(() =>
  db.db.collection("achievementsets"),
);
export const Asset = createMongoModel<Document>(() => db.db.collection("assets"));
export const Bundles = createMongoModel<Document>(() => db.db.collection("bundles"));
export const Changelog = createMongoModel<ChangelogType & Document>(() =>
  db.db.collection("changelogs_v2"),
);
export const Collection = createMongoModel<Document>(() =>
  db.db.collection("collections_v2"),
);
export const GamePosition = createMongoModel<Document>(() =>
  db.db.collection("game_positions"),
);
export const FreeGames = createMongoModel<Document>(() =>
  db.db.collection("freegames"),
);
export const Hltb = createMongoModel<Document>(() => db.db.collection("hltbs"));
export const Igdb = createMongoModel<Document>(() => db.db.collection("igdbs"));
export const Item = createMongoModel<Document>(() => db.db.collection("items"));
export const Mappings = createMongoModel<Document>(() => db.db.collection("mappings"));
export const Media = createMongoModel<Document>(() => db.db.collection("media"));
export const Offer = createMongoModel<OfferType & Document>(() =>
  db.db.collection("offers"),
);
export const PriceEngine = createMongoModel<PriceEngineType & Document>(() =>
  db.db.collection("pricev2"),
);
export const PriceEngineHistorical = createMongoModel<PriceEngineType & Document>(() =>
  db.db.collection("pricev2_historical"),
);
export const Ratings = createMongoModel<Document>(() => db.db.collection("ratings"));
export const Sandbox = createMongoModel<Document>(() => db.db.collection("sandboxes"));
export const Seller = createMongoModel<Document>(() => db.db.collection("sellers"));
export const Namespace = createMongoModel<Document>(() => db.db.collection("namespaces"));
export const TagModel = createMongoModel<Document>(() => db.db.collection("tags"));
export const Tags = createMongoModel<Document>(() => db.db.collection("tags"));
export const Franchise = createMongoModel<Document>(() => db.db.collection("franchises"));

export const User = createMongoModel<IUser & Document>(() => db.db.collection("users"));
export const PushSubscription = createMongoModel<IPushSubscription & Document>(() =>
  db.db.collection("pushsubscriptions"),
);
export const GoogleAuth = createMongoModel<IGoogleAuth & Document>(() =>
  db.db.collection("googleauths"),
);
export const Event = createMongoModel<Document>(() => db.db.collection("events"));
export const Rank = createMongoModel<Document>(() => db.db.collection("ranks"));
export const Review = createMongoModel<IReview & Document>(() => db.db.collection("reviews"));
export const OfferCountryPricingScore = createMongoModel<Document>(() =>
  db.db.collection("offer_country_pricing_scores"),
);
type Document = Record<string, any>;
