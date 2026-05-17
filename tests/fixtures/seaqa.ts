import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

type FixtureRecord = Record<string, unknown>;

export type SeaQaAttribute = {
  key?: string;
  type?: string;
  value?: string;
};

export type SeaQaOffer = FixtureRecord & {
  id: string;
  namespace: string;
  customAttributes?: SeaQaAttribute[];
};

export type SeaQaItem = FixtureRecord & {
  id: string;
  namespace: string;
  customAttributes?: SeaQaAttribute[];
};

export async function loadSeaQaOffers(): Promise<SeaQaOffer[]> {
  return loadFixture<SeaQaOffer>("egdata.offers.SeaQA.json");
}

export async function loadSeaQaItems(): Promise<SeaQaItem[]> {
  return loadFixture<SeaQaItem>("egdata.items.SeaQA.json");
}

async function loadFixture<T extends FixtureRecord>(
  fileName: string,
): Promise<T[]> {
  const raw = await readFile(join(HERE, fileName), "utf8");
  return normalizeMongoExport(JSON.parse(raw)) as T[];
}

function normalizeMongoExport(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeMongoExport);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);

    if (keys.length === 1 && "$date" in record) {
      return record.$date;
    }

    if (keys.length === 1 && "$oid" in record) {
      return record.$oid;
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, nested]) => [
        key,
        normalizeMongoExport(nested),
      ]),
    );
  }

  return value;
}
