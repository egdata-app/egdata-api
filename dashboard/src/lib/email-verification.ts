const storageKey = "egdata:email-verification";

/** Keep a fragment-only code across same-tab Epic login, never in OAuth URLs. */
export function rememberVerificationLink() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get(
    "verify-email",
  );
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ token, expiresAt: Date.now() + 30 * 60_000 }),
    );
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  } catch {
    // With storage disabled, the form can still read the fragment or pasted code.
  }
}

export function readVerificationToken(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1)).get(
    "verify-email",
  );
  if (fragment && /^[a-f0-9]{64}$/.test(fragment)) return fragment;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    return saved?.expiresAt > Date.now() && /^[a-f0-9]{64}$/.test(saved.token)
      ? saved.token
      : "";
  } catch {
    return "";
  }
}

export function clearVerificationToken() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage may be disabled. */
  }
  if (window.location.hash.startsWith("#verify-email="))
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
}
