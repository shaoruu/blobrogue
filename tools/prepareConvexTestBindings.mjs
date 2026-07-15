import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../convex/_generated/", import.meta.url));
mkdirSync(directory, { recursive: true });

writeFileSync(new URL("../convex/_generated/server.js", import.meta.url), `import {
  actionGeneric,
  httpActionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";

export const query = queryGeneric;
export const internalQuery = internalQueryGeneric;
export const mutation = mutationGeneric;
export const internalMutation = internalMutationGeneric;
export const action = actionGeneric;
export const internalAction = internalActionGeneric;
export const httpAction = httpActionGeneric;
`);

writeFileSync(new URL("../convex/_generated/api.js", import.meta.url), `import {
  anyApi,
  componentsGeneric,
} from "convex/server";

export const api = anyApi;
export const internal = anyApi;
export const components = componentsGeneric();
`);
