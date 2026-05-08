import { Hono } from "hono";
import client from "../../clients/redis.js";
import { db } from "../../db/index.js";
import { type IReview, Offer, Review } from "../../models/index.js";
import { getProduct } from "../../utils/get-product.js";
import { verifyGameOwnership } from "../../utils/verify-game-ownership.js";
import { epic, epicInfo } from "../auth.js";

const app = new Hono();

app.get("/reviews", epicInfo, async (c) => {
  const epic = c.var.epic;
  const session = c.var.session;
  const { id } = c.req.param();
  const page = Math.max(Number.parseInt(c.req.query("page") || "1", 10), 1);
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 25);
  const skip = (page - 1) * limit;

  const verifiedFilter = c.req.query("verified");

  const currentUser = session?.user?.email.split("@")[0] ?? epic?.account_id;

  const query: any = {
    id: id,
    userId: { $ne: currentUser },
  };

  if (verifiedFilter === "true") {
    query.verified = true;
  } else if (verifiedFilter === "false") {
    query.verified = false;
  }

  const reviews = await Review.find(query, undefined, {
    sort: {
      createdAt: -1,
    },
    limit,
    skip,
  });

  const userReview = currentUser
    ? await Review.findOne({
        userId: currentUser,
        id,
      })
    : null;

  if (userReview) {
    reviews.unshift(userReview);
  }

  if (!reviews) {
    c.status(200);
    return c.json({
      elements: [],
      page: 1,
      total: 0,
      limit,
    });
  }

  const users = await db.db
    .collection("epic")
    .find({
      accountId: { $in: reviews.map((r) => r.userId) },
    })
    .toArray();

  const result = {
    elements: reviews.map((r) => {
      const user = users.find((u) => u.accountId === r.userId);
      return {
        ...r.toObject(),
        user: user ?? null,
      };
    }),
    page,
    total: await Review.countDocuments(query),
    limit,
  };

  return c.json(result, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.post("/reviews", epic, async (c) => {
  const { id } = c.req.param();
  const body =
    await c.req.json<
      Omit<IReview, "id" | "createdAt" | "verified" | "userId">
    >();
  const epic = c.var.epic;
  const session = c.var.session;

  if ((!epic || !epic.account_id) && !session) {
    c.status(401);
    return c.json({
      message: "Unauthorized",
    });
  }

  if (!body || !body.rating || !body.title || !body.content) {
    c.status(400);
    return c.json({
      message: "Missing required fields",
    });
  }

  const existingReview = await Review.findOne({
    userId: session?.user?.email.split("@")[0] ?? epic?.account_id,
    id,
  });

  if (existingReview) {
    c.status(400);
    return c.json({
      message: "User already reviewed this product",
    });
  }

  const offer = await Offer.findOne({ id });

  if (
    !offer ||
    (offer.releaseDate || (offer.effectiveDate as Date)) > new Date()
  ) {
    c.status(400);
    return c.json({
      message: "Product not released",
    });
  }

  const product = await getProduct(id);

  if (!product) {
    c.status(404);
    return c.json({
      message: "Product not found",
    });
  }

  const isOwned =
    (session?.user?.email.split("@")[0] ?? epic?.account_id)
      ? await verifyGameOwnership(
          session?.user?.email.split("@")[0] ?? (epic?.account_id as string),
          product._id as unknown as string,
        )
      : false;

  const review: IReview = {
    id,
    rating: body.rating,
    title: body.title,
    content: body.content,
    tags: body.tags.slice(0, 5),
    verified: isOwned,
    userId: (session?.user?.email.split("@")[0] ?? epic?.account_id) as string,
    createdAt: new Date(),
    recommended: body.recommended,
    updatedAt: new Date(),
  };

  await Review.create(review);

  return c.json(
    {
      status: "ok",
    },
    201,
  );
});

app.patch("/reviews", epic, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<Omit<IReview, "id" | "createdAt" | "userId">>();
  const epic = c.var.epic;
  const session = c.var.session;

  if ((!epic || !epic.account_id) && !session) {
    c.status(401);
    return c.json({
      message: "Unauthorized",
    });
  }

  if (!body || !body.rating || !body.title || !body.content) {
    c.status(400);
    return c.json({
      message: "Missing required fields",
    });
  }

  const product = await getProduct(id);

  if (!product) {
    c.status(404);
    return c.json({
      message: "Product not found",
    });
  }

  const isOwned = ((session?.user?.email.split("@")[0] ??
    epic?.account_id) as string)
    ? await verifyGameOwnership(
        (session?.user?.email.split("@")[0] ?? epic?.account_id) as string,
        product._id as unknown as string,
      )
    : false;

  const oldReview = await Review.findOne({
    userId: (session?.user?.email.split("@")[0] ?? epic?.account_id) as string,
    id,
  });

  if (!oldReview) {
    c.status(404);
    return c.json({
      message: "Review not found",
    });
  }

  const review: Omit<IReview, "id" | "createdAt" | "userId"> = {
    rating: body.rating,
    title: body.title,
    content: body.content,
    tags: body.tags.slice(0, 5),
    verified: isOwned,
    recommended: body.recommended,
    updatedAt: new Date(),
    editions: [
      ...(oldReview.editions || []),
      {
        rating: oldReview.rating,
        title: oldReview.title,
        content: oldReview.content,
        tags: oldReview.tags,
        recommended: oldReview.recommended,
        createdAt: oldReview.updatedAt,
      },
    ],
  };

  await Review.findOneAndUpdate(
    {
      userId: (session?.user?.email.split("@")[0] ??
        epic?.account_id) as string,
      id,
    },
    review,
  );

  return c.json(
    {
      status: "ok",
    },
    200,
  );
});

app.delete("/reviews", epic, async (c) => {
  const { id } = c.req.param();
  const epic = c.var.epic;
  const session = c.var.session;

  if ((!epic || !epic.account_id) && !session) {
    c.status(401);
    return c.json({
      message: "Unauthorized",
    });
  }
  const review = await Review.findOne({
    userId: (session?.user?.email.split("@")[0] ?? epic?.account_id) as string,
    id,
  });

  if (!review) {
    c.status(404);
    return c.json({
      message: "Review not found",
    });
  }

  await Review.deleteOne({
    userId: (session?.user?.email.split("@")[0] ?? epic?.account_id) as string,
    id,
  });

  return c.json(
    {
      status: "ok",
    },
    200,
  );
});

type ReviewSummary = {
  overallScore: number;
  recommendedPercentage: number;
  notRecommendedPercentage: number;
  totalReviews: number;
};

app.get("/reviews-summary", async (c) => {
  const { id } = c.req.param();
  const verifiedFilter = c.req.query("verified");

  const cacheKey = `reviews-summary:${id}:${verifiedFilter}`;

  const cached = await client.get(cacheKey);

  if (cached) {
    return c.json(JSON.parse(cached), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  const query: any = { id };

  if (verifiedFilter === "true") {
    query.verified = true;
  } else if (verifiedFilter === "false") {
    query.verified = false;
  }

  const reviews = await Review.find(query);

  if (!reviews || reviews.length === 0) {
    c.status(200);
    return c.json({
      totalReviews: 0,
      averageRating: 0,
      recommendedPercentage: 0,
      notRecommendedPercentage: 0,
    });
  }

  const totalReviews = reviews.length;
  const averageRating =
    reviews.reduce((acc, r) => acc + r.rating, 0) / totalReviews;
  const recommendedPercentage =
    reviews.filter((r) => r.recommended).length / totalReviews;
  const notRecommendedPercentage =
    reviews.filter((r) => !r.recommended).length / totalReviews;

  const summary: ReviewSummary = {
    overallScore: averageRating,
    recommendedPercentage,
    notRecommendedPercentage,
    totalReviews,
  };

  await client.set(cacheKey, JSON.stringify(summary), "EX", 3600);

  return c.json(summary, 200, {
    "Cache-Control": "public, max-age=60",
  });
});

app.get("/reviews/permissions", epic, async (c) => {
  const { id } = c.req.param();
  const epic = c.var.epic;
  const session = c.var.session;

  if ((!epic || !epic.account_id) && !session) {
    c.status(401);
    return c.json({
      message: "Unauthorized",
    });
  }

  const existingReview = await Review.findOne({
    userId: session?.user?.email.split("@")[0] ?? epic?.account_id,
    id,
  });

  return c.json({
    canReview: !existingReview,
  });
});

export default app;
