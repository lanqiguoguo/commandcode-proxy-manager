const REGISTRY_URL = "https://registry.npmjs.org/command-code/latest";
const target = process.env.CC_VERSION_TEST_REGISTRY_TARGET;
if (!target) throw new Error("CC_VERSION_TEST_REGISTRY_TARGET is required");

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  if (url === REGISTRY_URL) return originalFetch(target, init);
  return originalFetch(input, init);
};
