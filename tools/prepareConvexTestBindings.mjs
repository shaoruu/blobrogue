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

writeFileSync(new URL("../convex/_generated/server.d.ts", import.meta.url), `import type {
  ActionBuilder,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import type { DataModel } from "./dataModel.js";

export declare const query: QueryBuilder<DataModel, "public">;
export declare const internalQuery: QueryBuilder<DataModel, "internal">;
export declare const mutation: MutationBuilder<DataModel, "public">;
export declare const internalMutation: MutationBuilder<DataModel, "internal">;
export declare const action: ActionBuilder<DataModel, "public">;
export declare const internalAction: ActionBuilder<DataModel, "internal">;
export declare const httpAction: HttpActionBuilder;

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
`);

writeFileSync(new URL("../convex/_generated/api.js", import.meta.url), `import {
  anyApi,
  componentsGeneric,
} from "convex/server";

export const api = anyApi;
export const internal = anyApi;
export const components = componentsGeneric();
`);

writeFileSync(new URL("../convex/_generated/api.d.ts", import.meta.url), `import type {
  AnyApi,
  AnyComponents,
} from "convex/server";

export declare const api: AnyApi;
export declare const internal: AnyApi;
export declare const components: AnyComponents;
`);

writeFileSync(new URL("../convex/_generated/dataModel.d.ts", import.meta.url), `import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type Id<TableName extends TableNames> = GenericId<TableName>;
`);
