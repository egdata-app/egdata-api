import { z } from "zod";

const strings = z
  .array(z.string().trim().min(1))
  .transform((values) => [...new Set(values)].sort())
  .optional();
const text = z.string().trim().optional();
const flag = z.boolean().optional();

// Strip unknown keys before building a URL or an OpenSearch query.
export const searchV2InputSchema = z.object({
  title: text,
  offerType: text,
  tags: strings,
  categories: strings,
  customAttributes: strings,
  technologies: strings,
  seller: text,
  developerDisplayName: text,
  publisherDisplayName: text,
  refundType: text,
  isCodeRedemptionOnly: flag,
  excludeBlockchain: flag,
  onSale: flag,
  pastGiveaways: flag,
  isLowestPrice: flag,
  isLowestPriceEver: flag,
  sortBy: z
    .enum([
      "releaseDate",
      "lastModifiedDate",
      "effectiveDate",
      "creationDate",
      "viewableDate",
      "pcReleaseDate",
      "upcoming",
      "priceAsc",
      "priceDesc",
      "price",
      "discount",
      "discountPercent",
      "priceUpdatedAt",
      "giveawayDate",
    ])
    .optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  limit: z
    .number()
    .int()
    .transform((value) => Math.max(1, Math.min(value, 100)))
    .default(10),
  page: z
    .number()
    .int()
    .transform((value) => Math.max(1, value))
    .default(1),
  price: z
    .object({ min: z.number().optional(), max: z.number().optional() })
    .optional(),
  facets: z
    .preprocess(
      (value) => (value === "minimal" || value === "none" ? value : "full"),
      z.enum(["full", "minimal", "none"]),
    )
    .default("full"),
});

export function searchV2QueryParams(
  input: z.output<typeof searchV2InputSchema>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === "") continue;
    if (key === "price") {
      for (const [bound, amount] of Object.entries(value)) {
        if (amount !== undefined)
          params.set(bound === "min" ? "priceMin" : "priceMax", String(amount));
      }
    } else if (Array.isArray(value)) {
      // Bracketed parameters preserve literal commas inside individual values.
      if (value.some((item) => item.includes(","))) {
        for (const item of value) params.append(`${key}[]`, item);
      } else if (value.length) {
        params.set(key, value.join(","));
      }
    } else if (
      !(
        (key === "page" && value === 1) ||
        (key === "limit" && value === 10) ||
        (key === "facets" && value === "full") ||
        (key === "sortDir" && value === "desc")
      )
    ) {
      params.set(key, String(value));
    }
  }
  return params;
}
