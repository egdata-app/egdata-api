export const AFFILIATION_DISCLAIMER_STORAGE_KEY =
  "egdata:affiliation-disclaimer-acknowledged";
export const AFFILIATION_DISCLAIMER_VERSION = "1";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function resolveBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function hasAcknowledgedAffiliationDisclaimer(
  storage?: StorageReader | null,
): boolean {
  const target = storage !== undefined ? storage : resolveBrowserStorage();
  if (!target) return false;
  try {
    return (
      target.getItem(AFFILIATION_DISCLAIMER_STORAGE_KEY) ===
      AFFILIATION_DISCLAIMER_VERSION
    );
  } catch {
    return false;
  }
}

export function shouldShowAffiliationDisclaimer(
  storage?: StorageReader | null,
): boolean {
  if (storage === undefined && typeof window === "undefined") return false;
  return !hasAcknowledgedAffiliationDisclaimer(storage);
}

export function acknowledgeAffiliationDisclaimer(
  storage?: StorageWriter | null,
): void {
  const target = storage !== undefined ? storage : resolveBrowserStorage();
  if (!target) return;
  try {
    target.setItem(
      AFFILIATION_DISCLAIMER_STORAGE_KEY,
      AFFILIATION_DISCLAIMER_VERSION,
    );
  } catch {
    // With storage disabled, dismissal still closes the modal for the current session.
  }
}
