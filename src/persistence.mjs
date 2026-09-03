// Shared status for durable writes. A scheduled debounce is not a durable write.
let available = true;
const failures = new Map();

export function markPersistenceSuccess(scope = "data") {
  failures.delete(scope);
  available = failures.size === 0;
}

export function markPersistenceFailure(error, scope = "data") {
  available = false;
  failures.set(scope, error instanceof Error ? error : new Error(String(error)));
}

export function getPersistenceStatus() {
  const firstFailure = failures.values().next().value;
  return {
    available: available && failures.size === 0,
    error: firstFailure ? {
      code: firstFailure.code || "PERSISTENCE_ERROR",
      message: firstFailure.message,
      scopes: [...failures.keys()]
    } : null
  };
}

export function persistenceError(operation, cause) {
  const source = cause instanceof Error ? cause : new Error(String(cause));
  const error = new Error(operation + ": " + source.message, { cause: source });
  error.code = "PERSISTENCE_ERROR";
  error.statusCode = 503;
  error.persistence = true;
  return error;
}
