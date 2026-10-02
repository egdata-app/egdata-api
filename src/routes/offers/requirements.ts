import { Hono } from "hono";
import { Offer } from "../../models/index.js";
import { resolveOfferRequirements } from "../../utils/offer-requirements.js";

const app = new Hono();

app.get("/requirements", async (c) => {
  const offerId = c.req.param("id");
  if (!offerId) {
    return c.json({ message: "Offer not found" }, 404);
  }

  const offer = await Offer.findOne({ id: offerId }).lean();

  if (!offer) {
    return c.json({ message: "Offer not found" }, 404);
  }

  const [windows, macos] = await Promise.all([
    resolveOfferRequirements(offer.namespace, offerId, "windows"),
    resolveOfferRequirements(offer.namespace, offerId, "macos"),
  ]);

  if (!windows && !macos) {
    return c.json({ message: "Offer requirements not found" }, 404);
  }

  return c.json({ windows, macos }, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

export default app;
