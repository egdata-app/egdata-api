# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

egdata-api is a TypeScript REST API and GraphQL server for Epic Games Store data. It provides endpoints for game offers, items, prices, user profiles, free games, and related data. The API serves https://egdata.app.

## Development Commands

```bash
# Install dependencies (uses pnpm)
pnpm install

# Start development server with hot reload (runs on port 4000)
pnpm dev

# Build for production
pnpm build

# Start production server
pnpm start

# Start Redis (required, WSL)
sudo service redis-server start

# Lint and format (uses Biome)
pnpm biome check .
pnpm biome check --write .
```

## Architecture

### Framework & Runtime
- **Runtime**: Node.js 22
- **Web Framework**: Hono (lightweight, Express-like)
- **Build Tool**: rslib (Rust-based bundler, outputs ESM to `/dist`)
- **GraphQL**: Apollo Server with custom Hono middleware

### Data Layer
- **Primary Database**: MongoDB via Mongoose (TLS/X.509 auth)
- **Caching**: Redis/IORedis for response caching and rate limiting
- **Search**: MeiliSearch (primary) and OpenSearch (analytics)
- **Schemas**: External packages `@egdata/core.schemas.*` define Mongoose models (Offer, Item, PriceEngine, Tags, etc.)

### Key Directories
- `src/routes/` - Feature-based REST endpoint handlers (offers.ts is the largest at ~110KB)
- `src/db/` - MongoDB connection and local Mongoose schemas (events, reviews, users, auth)
- `src/clients/` - External service clients (Redis, Epic Games GraphQL, Discord, MeiliSearch, Telegram)
- `src/utils/` - Shared utilities (auth, JWT, image processing, data transformations)
- `src/graphql/` - Apollo Server setup, typedefs, and resolvers
- `src/middlewares/` - Hono middleware (JWT auth, Apollo integration)
- `src/trigger/` - Scheduled background jobs via Trigger.dev

### Entry Point
`src/index.ts` initializes the Hono app, registers all routes via `app.route()`, and starts the server on port 4000.

### Route Registration Pattern
Routes are organized by feature and registered in `src/index.ts`:
```typescript
app.route("/offers", OffersRoute);
app.route("/search", SearchRoute);
// etc.
```

### Caching Pattern
Redis cache-aside pattern is used throughout:
```typescript
const cached = await client.get(cacheKey);
if (cached) return c.json(JSON.parse(cached));
// ... fetch from DB ...
await client.set(cacheKey, JSON.stringify(result), "EX", ttlSeconds);
```

### Image Generation
Some routes (collections, profiles) use JSX with Satori + Resvg to generate OG images on-demand. These files have `.tsx` extension.

## External Schemas

The project uses shared Mongoose schemas from `@egdata/core.schemas.*` packages:
- `Offer` - Game offers/products
- `Item` - Game items and content
- `PriceEngine` - Regional pricing data
- `Tags`, `TagModel` - Game categorization
- `Asset`, `Seller`, `Changelog`, etc.

## Environment Variables

Key variables (see `.env.example`):
- `MONGO_URL`, `MONGO_CA`, `MONGO_CERT` - MongoDB connection
- `REDISHOST`, `REDISPORT`, `REDISPASSWORD` - Redis connection
- `MEILISEARCH_API_KEY`, `MEILISEARCH_INSTANCE` - Search engine
- `EPIC_CLIENT_ID`, `EPIC_CLIENT_SECRET` - Epic Games OAuth
- `JWT_SECRET`, `JWT_PUBLIC_KEY` - Authentication
