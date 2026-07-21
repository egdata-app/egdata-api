import type { Context, Next } from "hono";
import { etag } from "hono/etag";

const applyEtag = etag();

export const responseEtag = async (c: Context, next: Next): Promise<void> => {
  if (c.req.path === "/catalog/hydrate") {
    await next();
    return;
  }

  await applyEtag(c, next);
};
