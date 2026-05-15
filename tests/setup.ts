import { config } from "dotenv";

config();

// Vitest setup file. Runs once per worker before the test suite.
//
// Route tests import `../src/index.js`, which has top-level Apollo/server
// initialization. They also expect MongoDB to be reachable; the actual
// `db.connect()` call is wired up lazily in `tests/routes.test.ts` so unit
// tests in `tests/utils/` can run without infra.
//
// Add any cross-cutting test setup here (mocks, fake timers, etc.).
