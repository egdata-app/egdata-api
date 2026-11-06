/** Incompatible fingerprint/features must not reuse earlier risk or trial state. */
export const ABUSE_VERSION = 2;
export const RISK_PREFIX = `egdata:abuse:v${ABUSE_VERSION}:`;
export function riskRedisKeys(key: string): [string, string] {
  return [`${RISK_PREFIX}{${key}}:events`, `${RISK_PREFIX}{${key}}:trap`];
}
