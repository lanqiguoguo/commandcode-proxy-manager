// Schemas for the three mutable JSON files. Invalid documents are rejected as
// a whole by readValidatedJson so no partially trusted object reaches runtime.

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_ID_LENGTH = 128;
const MAX_KEY_LENGTH = 512;
const MAX_TEXT_LENGTH = 1024;
const MAX_PERCENT = 1_000_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const USER_KEY = /^user_[A-Za-z0-9_-]+$/;
const HEALTH_NUMBER_RULES = {
  backoffUntilMs: { integer: true, max: MAX_SAFE },
  failCount: { integer: true, max: 1_000_000 },
  quotaLimitedUntil: { integer: true, max: MAX_SAFE },
  failoverCount: { integer: true, max: 1_000_000_000 },
  lastFailoverAt: { integer: true, max: MAX_SAFE },
  lastUsedAt: { integer: true, max: MAX_SAFE }
};
const HEALTH_BOOLEAN_FIELDS = ["authError", "softLimited"];
const HEALTH_ERROR_KINDS = ["", "rate_limit", "timeout", "auth", "quota"];
function issue(field, message) {
  return { field, message };
}

function addIssue(errors, field, message) {
  if (errors.length < 64) errors.push(issue(field, message));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validText(value, max, allowEmpty = true) {
  return typeof value === "string" && value.length <= max &&
    (allowEmpty || value.length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && SAFE_ID.test(value);
}

function validTimestamp(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE;
}

function validFiniteNonNegative(value, max = MAX_SAFE) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

function validTimeString(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function validateKeysItem(item, index, errors, ids, keyValues, priorities, count) {
  const path = `keys[${index}]`;
  if (!isRecord(item)) {
    addIssue(errors, path, "must be an object");
    return;
  }

  if (!hasOwn(item, "id") || !validId(item.id)) addIssue(errors, `${path}.id`, "must be a non-empty safe string of at most 128 characters");
  else if (ids.has(item.id)) addIssue(errors, `${path}.id`, "must be unique");
  else ids.add(item.id);

  if (!hasOwn(item, "key") || typeof item.key !== "string" || item.key.length > MAX_KEY_LENGTH || !USER_KEY.test(item.key)) {
    addIssue(errors, `${path}.key`, "must match user_<letters-numbers-_> and be at most 512 characters");
  } else if (keyValues.has(item.key)) {
    addIssue(errors, `${path}.key`, "must be unique");
  } else {
    keyValues.add(item.key);
  }

  if (!hasOwn(item, "priority") || typeof item.priority !== "number" || !Number.isSafeInteger(item.priority) || item.priority < 0 || item.priority >= count) {
    addIssue(errors, `${path}.priority`, `must be an integer in 0..${Math.max(0, count - 1)}`);
  } else if (priorities.has(item.priority)) {
    addIssue(errors, `${path}.priority`, "must be unique and form a contiguous ordering");
  } else {
    priorities.add(item.priority);
  }

  if (!hasOwn(item, "enabled") || typeof item.enabled !== "boolean") {
    addIssue(errors, `${path}.enabled`, "must be a boolean");
  }
  if (hasOwn(item, "type") && (!validText(item.type, 32, false))) {
    addIssue(errors, `${path}.type`, "must be a non-empty string of at most 32 characters");
  }
  if (hasOwn(item, "alias") && !validText(item.alias, 64)) {
    addIssue(errors, `${path}.alias`, "must be a string of at most 64 characters");
  }
  if (hasOwn(item, "note") && !validText(item.note, 256)) {
    addIssue(errors, `${path}.note`, "must be a string of at most 256 characters");
  }
  if (hasOwn(item, "createdAt") && !validTimestamp(item.createdAt)) {
    addIssue(errors, `${path}.createdAt`, "must be a non-negative safe integer timestamp");
  }
}

export function validateKeysDocument(document) {
  const errors = [];
  if (!isRecord(document)) {
    return [issue("$", "must be an object, not null, an array, or a scalar")];
  }
  if (!hasOwn(document, "keys")) {
    addIssue(errors, "keys", "is required");
    return errors;
  }
  if (!Array.isArray(document.keys)) {
    addIssue(errors, "keys", "must be an array");
    return errors;
  }
  const ids = new Set();
  const keyValues = new Set();
  const priorities = new Set();
  document.keys.forEach((item, index) => validateKeysItem(item, index, errors, ids, keyValues, priorities, document.keys.length));
  return errors;
}

function validateHealthEntry(entry, path, errors) {
  if (!isRecord(entry)) {
    addIssue(errors, path, "must be an object");
    return;
  }
  for (const [field, rule] of Object.entries(HEALTH_NUMBER_RULES)) {
    if (!hasOwn(entry, field)) continue;
    const value = entry[field];
    const valid = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= rule.max &&
      (!rule.integer || Number.isSafeInteger(value));
    if (!valid) addIssue(errors, `${path}.${field}`, "must be a finite non-negative number in the supported range");
  }
  for (const field of HEALTH_BOOLEAN_FIELDS) {
    if (hasOwn(entry, field) && typeof entry[field] !== "boolean") addIssue(errors, `${path}.${field}`, "must be a boolean");
  }
  if (hasOwn(entry, "lastErrorKind") && (!validText(entry.lastErrorKind, 32) || !HEALTH_ERROR_KINDS.includes(entry.lastErrorKind))) {
    addIssue(errors, `${path}.lastErrorKind`, "must be one of empty, rate_limit, timeout, auth, or quota");
  }
  if (hasOwn(entry, "quotaLimitedReason") && (!validText(entry.quotaLimitedReason, 32) || !["", "fiveHour", "weekly", "credits"].includes(entry.quotaLimitedReason))) {
    addIssue(errors, `${path}.quotaLimitedReason`, "must be empty, fiveHour, weekly, or credits");
  }
}

export function validateStateDocument(document, options = {}) {
  const errors = [];
  if (!isRecord(document)) return [issue("$", "must be an object, not null, an array, or a scalar")];
  if (!hasOwn(document, "keys")) {
    addIssue(errors, "keys", "is required");
    return errors;
  }
  if (!isRecord(document.keys)) {
    addIssue(errors, "keys", "must be an object map, not null or an array");
    return errors;
  }
  const knownIds = options.knownIds instanceof Set ? options.knownIds : null;
  for (const [id, entry] of Object.entries(document.keys)) {
    // State belongs to the current keys document. Unknown entries are kept in
    // the quarantinable source document for diagnostics but are never trusted.
    if (knownIds && !knownIds.has(id)) continue;
    if (!validId(id)) {
      addIssue(errors, `keys.${id || "<empty>"}`, "must use a safe key id");
      continue;
    }
    validateHealthEntry(entry, `keys.${id}`, errors);
  }
  return errors;
}

function validateWindow(window, path, errors) {
  if (!isRecord(window)) {
    addIssue(errors, path, "must be an object or null");
    return;
  }
  for (const field of ["cap", "used", "percent"]) {
    if (!hasOwn(window, field) || !validFiniteNonNegative(window[field], MAX_SAFE)) {
      addIssue(errors, `${path}.${field}`, "must be a finite non-negative number");
    }
  }
  if (validFiniteNonNegative(window.cap) && window.cap <= 0) addIssue(errors, `${path}.cap`, "must be greater than zero");
  if (validFiniteNonNegative(window.percent) && window.percent > MAX_PERCENT) addIssue(errors, `${path}.percent`, "is outside the supported range");
  if (!hasOwn(window, "resetAt") || (window.resetAt !== null && !validTimeString(window.resetAt))) {
    addIssue(errors, `${path}.resetAt`, "must be null or a valid time string");
  }
  if (validFiniteNonNegative(window.cap) && window.cap > 0 && validFiniteNonNegative(window.used) && validFiniteNonNegative(window.percent)) {
    const expected = Math.round((window.used / window.cap) * 1000) / 10;
    if (!Number.isFinite(expected) || Math.abs(expected - window.percent) > 0.1) {
      addIssue(errors, `${path}.percent`, "does not match used/cap");
    }
  }
}

function validateCredits(credits, path, errors) {
  if (!isRecord(credits)) {
    addIssue(errors, path, "must be an object or null");
    return;
  }
  for (const field of ["used", "remaining", "limit", "percent"]) {
    if (!hasOwn(credits, field) || !validFiniteNonNegative(credits[field])) {
      addIssue(errors, `${path}.${field}`, "must be a finite non-negative number");
    }
  }
  if (validFiniteNonNegative(credits.percent) && credits.percent > 100) addIssue(errors, `${path}.percent`, "must be at most 100");
  // periodStart was added after the first quota-cache format and is absent
  // from otherwise valid legacy credits reports.
  if (hasOwn(credits, "periodStart") && !validTimeString(credits.periodStart)) {
    addIssue(errors, `${path}.periodStart`, "must be a valid time string");
  }
  if (hasOwn(credits, "expiresAt") && credits.expiresAt !== null && !validTimeString(credits.expiresAt)) {
    addIssue(errors, `${path}.expiresAt`, "must be null or a valid time string");
  }
  if (validFiniteNonNegative(credits.used) && validFiniteNonNegative(credits.remaining) && validFiniteNonNegative(credits.limit)) {
    const expectedLimit = credits.used + credits.remaining;
    if (!Number.isFinite(expectedLimit) || Math.abs(expectedLimit - credits.limit) > Math.max(1e-9, credits.limit * 1e-9)) {
      addIssue(errors, `${path}.limit`, "must equal used + remaining");
    }
    if (credits.limit === 0 && credits.percent !== 0) addIssue(errors, `${path}.percent`, "must be zero when limit is zero");
    if (credits.limit > 0 && validFiniteNonNegative(credits.percent)) {
      const expectedPercent = Math.round((credits.used / credits.limit) * 1000) / 10;
      if (!Number.isFinite(expectedPercent) || Math.abs(expectedPercent - credits.percent) > 0.1) {
        addIssue(errors, `${path}.percent`, "does not match used/limit");
      }
    }
  }
}

function validateTotals(totals, path, errors) {
  if (!isRecord(totals)) {
    addIssue(errors, path, "must be an object or null");
    return;
  }
  for (const field of ["runs", "completed", "failed", "tokensIn", "tokensOut", "tokens", "cost"]) {
    if (!hasOwn(totals, field) || !validFiniteNonNegative(totals[field])) {
      addIssue(errors, `${path}.${field}`, "must be a finite non-negative number");
    }
  }
  for (const field of ["runs", "completed", "failed", "tokensIn", "tokensOut", "tokens"]) {
    if (hasOwn(totals, field) && validFiniteNonNegative(totals[field]) && !Number.isSafeInteger(totals[field])) {
      addIssue(errors, `${path}.${field}`, "must be an integer");
    }
  }
  if (hasOwn(totals, "successRate") && (!validFiniteNonNegative(totals.successRate, 100) || totals.successRate > 100)) {
    addIssue(errors, `${path}.successRate`, "must be a number in 0..100");
  }
  if (validFiniteNonNegative(totals.runs) && validFiniteNonNegative(totals.completed) && validFiniteNonNegative(totals.failed) &&
      totals.completed + totals.failed > totals.runs) {
    addIssue(errors, `${path}.completed`, "plus failed must not exceed runs");
  }
}

function validateQuotaReport(report, path, errors) {
  if (!isRecord(report)) {
    addIssue(errors, path, "must be an object");
    return;
  }
  if (!hasOwn(report, "stale") || typeof report.stale !== "boolean") addIssue(errors, `${path}.stale`, "must be a boolean");
  if (!hasOwn(report, "updatedAt") || (report.updatedAt !== null && !validTimestamp(report.updatedAt))) {
    addIssue(errors, `${path}.updatedAt`, "must be null or a non-negative safe integer timestamp");
  }
  for (const field of ["fiveHour", "weekly"]) {
    if (!hasOwn(report, field)) addIssue(errors, `${path}.${field}`, "is required");
    else if (report[field] !== null) validateWindow(report[field], `${path}.${field}`, errors);
  }
  if (!hasOwn(report, "creditsUsd")) addIssue(errors, `${path}.creditsUsd`, "is required");
  // totals was introduced by F06. Missing is a valid legacy-cache shape and
  // is equivalent to the current null value for the UI.
  if (hasOwn(report, "totals") && report.totals !== null) validateTotals(report.totals, `${path}.totals`, errors);
  if (hasOwn(report, "creditsUsd") && report.creditsUsd !== null) validateCredits(report.creditsUsd, `${path}.creditsUsd`, errors);
  if (hasOwn(report, "error") && !validText(report.error, MAX_TEXT_LENGTH)) addIssue(errors, `${path}.error`, "must be a string of at most 1024 characters");
  if (report.stale === false) {
    if (report.updatedAt === null) addIssue(errors, `${path}.updatedAt`, "is required for a fresh report");
    if (report.fiveHour === null || report.weekly === null) addIssue(errors, `${path}`, "fresh reports require both quota windows");
  }
}

export function validateQuotaCacheDocument(document, options = {}) {
  const errors = [];
  if (!isRecord(document)) return [issue("$", "must be an object, not null, an array, or a scalar")];
  if (!hasOwn(document, "reports")) {
    addIssue(errors, "reports", "is required");
    return errors;
  }
  if (!isRecord(document.reports)) {
    addIssue(errors, "reports", "must be an object map, not null or an array");
    return errors;
  }
  const knownIds = options.knownIds instanceof Set ? options.knownIds : null;
  for (const [id, report] of Object.entries(document.reports)) {
    if (knownIds && !knownIds.has(id)) continue;
    if (!validId(id)) {
      addIssue(errors, `reports.${id || "<empty>"}`, "must use a safe key id");
      continue;
    }
    validateQuotaReport(report, `reports.${id}`, errors);
  }
  return errors;
}
