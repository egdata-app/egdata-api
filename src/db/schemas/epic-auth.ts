import { createMongoModel } from "../../models/mongo-model.js";
import { db } from "../index.js";

export const EpicAuth = createMongoModel<Record<string, unknown>>(() =>
  db.db.collection("epicauths"),
);
export const EpicAuthSchema = {};
