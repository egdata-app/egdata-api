import { Offer } from "@egdata/core.schemas.offers";
import { Hono } from "hono";

const app = new Hono();

const TIMES_INDEX = {
  "2023": {
    "start": "2023-12-08T00:30:00.000Z",
    "end": "2023-12-08T03:30:00.000Z"
  },
  "2024": {
    "start": "2024-12-13T00:30:00.000Z",
    "end": "2024-12-13T04:00:00.000Z"
  },
  "2025": {
    "start": "2025-12-12T01:30:00.000Z",
    "end": "2025-12-12T04:30:00.000Z"
  }
} as Record<string, { start: string; end: string }>;

app.get("/:year", async (c) => {
    const year = c.req.param("year");

    if (!TIMES_INDEX[year]) {
        return c.json({ error: "Year not found" }, 404);
    }

    const offers = await Offer.find({
        $or: [
        {
            viewableDate: {
            $gte: new Date(TIMES_INDEX[year].start),
            $lte: new Date(TIMES_INDEX[year].end)
            }
        },
        {
            creationDate: {
            $gte: new Date(TIMES_INDEX[year].start),
            $lte: new Date(TIMES_INDEX[year].end)
            }
        }
        ],
        "offerType": "BASE_GAME"
    })

    return c.json(offers);
});

export default app;
