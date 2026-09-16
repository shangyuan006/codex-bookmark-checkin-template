import { localRunDate } from "./retry-policy.mjs";

// Recovery decisions are account-scoped by the caller. A storage boolean alone
// has no date and cannot establish today's reauthentication.
export function reauthRecoveryAction(previous, now = new Date()) {
  const date = localRunDate(now);
  const updatedAt = new Date(previous?.updatedAt);
  if (previous?.date !== date || !Number.isFinite(updatedAt.getTime())
    || updatedAt > now || localRunDate(updatedAt) !== date) return "restart";
  if (previous.status === "completed") return "complete";
  if (previous.status === "logged_out" && previous.loginEvidenceReset === true) return "resume";
  return "restart";
}

export function hasCurrentReauthEvidence(login, previous, now = new Date()) {
  return reauthRecoveryAction(previous, now) === "resume"
    && login?.valid === true && login?.explicitLoginSuccess === true;
}

export async function resetReauthLoginEvidence(page, rule) {
  const evidence = rule.loginSuccessStorageEvidence;
  if (!evidence) return false;
  return page.evaluate(({ storage: storageName, key, field, expected }) => {
    const storage = storageName === "sessionStorage" ? sessionStorage : localStorage;
    const raw = storage.getItem(key);
    if (raw == null) return true;
    const parsed = JSON.parse(raw);
    const parts = field.split(".");
    let parent = parsed;
    for (const part of parts.slice(0, -1)) parent = parent?.[part];
    if (parent && typeof parent === "object") {
      parent[parts.at(-1)] = !expected;
      storage.setItem(key, JSON.stringify(parsed));
    }
    return true;
  }, evidence);
}
