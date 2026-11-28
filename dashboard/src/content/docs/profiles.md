---
title: Player profiles
description: Retrieve public Epic player profiles, game libraries, achievements, and leaderboards via REST.
---

Use the `/v1/profiles/*` REST endpoints under `https://api.egdata.app/v1` to inspect public Epic Games profiles, game completion summaries, unlocked and rare achievements, and the global XP leaderboard. All profile endpoints require an API key (`X-API-Key: <key>` or `Authorization: Bearer <key>`) with the `profiles:read` scope and are governed by the `heavy` per-minute rate-limit policy.

```js
const response = await fetch(
  "https://api.egdata.app/v1/profiles/epic-account-id/games?sort=completion&limit=20",
  {
    headers: {
      "X-API-Key": process.env.EGDATA_API_KEY,
    },
  },
);

if (!response.ok) {
  throw new Error(`Profile request failed (${response.status})`);
}

const result = await response.json();
```

## Endpoints

| Endpoint | Purpose | Pagination |
| --- | --- | --- |
| `GET /v1/profiles/{id}` | Basic profile identity, avatar, linked accounts, review count, and per-sandbox achievement summary | None |
| `GET /v1/profiles/{id}/information` | Detailed profile statistics (`totalGames`, `totalAchievements`, `totalPlayerAwards`, `totalXP`, `reviewsCount`), donations, and Discord link status | None |
| `GET /v1/profiles/{id}/games` | Player's game library with completion, XP, and base-offer metadata | Cursor (`limit` default 20, max 100) |
| `GET /v1/profiles/{id}/achievements` | Unlocked achievements across all games, newest unlock first | Cursor (`limit` default 20, max 100) |
| `GET /v1/profiles/{id}/achievements/{sandboxId}` | Player progress and achievement-set definitions for one sandbox | None |
| `GET /v1/profiles/{id}/rare-achievements` | Up to 25 rarest unlocked achievements across the profile | None |
| `GET /v1/profiles/{id}/rare-achievements/{sandboxId}` | Up to 3 rarest unlocked achievements in a specific sandbox | None |
| `GET /v1/profiles/{id}/random-game` | Random base-game offer from the profile's library (or a specific game via optional `sandbox` query param) | None |
| `GET /v1/profiles/leaderboard` | Global XP leaderboard ordered by rank | Cursor (`limit` default 20, max 100) |

## Filtering and sorting `/v1/profiles/{id}/games`

`GET /v1/profiles/{id}/games` supports forward cursor pagination (`cursor`, `limit`) alongside:

- `sort`: `completion` (default), `alphabetical`, `xp`, or `achievements`
- `filter`: `all` (default), `completed`, `near-platinum`, `in-progress`, or `platinum`
- `platinum`: `true` or `false` (applies platinum-only filtering when `filter` is omitted or `all`)

The response places the page inside `data.achievements` (keeping the legacy array key) and cursor state under `meta.pagination`:

```json
{
  "data": {
    "achievements": [
      {
        "sandboxId": "sandbox-0",
        "totalUnlocked": 9,
        "totalXP": 1000,
        "playerAwards": [],
        "productAchievements": {
          "totalAchievements": 10,
          "totalProductXP": 1000
        },
        "completionPercentage": 0.9,
        "baseOfferForSandbox": {
          "id": "offer-0",
          "namespace": "sandbox-0",
          "keyImages": []
        },
        "product": {
          "name": "Game 0",
          "slug": "game-0"
        }
      }
    ]
  },
  "meta": {
    "pagination": {
      "limit": 20,
      "hasMore": false,
      "nextCursor": null,
      "total": 1
    }
  }
}
```

## Profile summary, achievements, and leaderboard shapes

- `GET /v1/profiles/{id}` returns `data` with `accountId`/`epicAccountId`, `displayName`, `avatar`, `linkedAccounts`, `creationDate`, `reviews`, and `achievements` (`{ __typename, status, data }`), with `meta: {}`.
- `GET /v1/profiles/{id}/information` returns `data` with `stats` (`totalGames`, `totalAchievements`, `totalPlayerAwards`, `totalXP`, `reviewsCount`), `avatar`, `linkedAccounts`, `creationDate`, `donations`, and `discord`, with `meta: {}`.
- `GET /v1/profiles/{id}/achievements` returns `data: { achievements, count }` and `meta.pagination`. `GET /v1/profiles/{id}/achievements/{sandboxId}` returns `data: { playerAchievements, sandboxAchievements }` and `meta: {}`.
- `GET /v1/profiles/{id}/rare-achievements` and `/v1/profiles/{id}/rare-achievements/{sandboxId}` return `data: [...]` and `meta: {}`.
- `GET /v1/profiles/{id}/random-game` returns the serialized base-game offer object in `data` and `meta: {}`.
- `GET /v1/profiles/leaderboard` returns `data` as an array of entries (`rank`, `accountId`, `displayName`, `xpEarned`, `achievementsWon`, `awardsEarned`, `awardsByType`) with `meta.pagination`.

## Errors

Missing profiles or achievement records return RFC 9457 `404` Problem Details with stable codes including [PROFILE_NOT_FOUND](/docs/profile-not-found), [PROFILE_ACHIEVEMENTS_NOT_FOUND](/docs/profile-achievements-not-found), and [PROFILE_SANDBOX_ACHIEVEMENTS_NOT_FOUND](/docs/profile-sandbox-achievements-not-found). See the [API reference](/docs) for full schemas and interactive testing.
