import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import type { AbuseResource } from "../services/abuse-scorer.js";

export interface AbuseTelemetryContext {
  abuseTelemetry?: (resource: AbuseResource) => void;
}

/** Capture coerced arguments from executed fields, not raw query text or aliases. */
export function createAbuseTelemetryPlugin<
  T extends BaseContext & AbuseTelemetryContext,
>(): ApolloServerPlugin<T> {
  return {
    async requestDidStart({ contextValue }) {
      const record = contextValue.abuseTelemetry;
      if (!record) return;
      let recorded = 0;
      return {
        async executionDidStart() {
          return {
            willResolveField({ args, info }) {
              if (recorded >= 32) return;
              const page =
                typeof args.page === "number" &&
                Number.isSafeInteger(args.page) &&
                args.page >= 0
                  ? args.page
                  : undefined;
              const root = info.parentType === info.schema.getQueryType();
              // Nested paginated fields matter; leaf fields do not represent requests.
              if (!root && page === undefined) return;
              const itemId =
                root && typeof args.id === "string"
                  ? args.id.slice(0, 128)
                  : undefined;
              recorded++;
              record({
                route: `/graphql/${info.parentType.name}.${info.fieldName}`,
                page,
                itemId,
                ...(root &&
                info.fieldName === "offer" &&
                itemId &&
                /^[a-f0-9]{32}$/.test(itemId) &&
                ["OfferOnly", "OfferPage"].includes(
                  info.operation.name?.value ?? "",
                ) &&
                page === undefined
                  ? {
                      hydrationId: itemId,
                      hydrationRoute: `graphql:${info.operation.name?.value}`,
                    }
                  : {}),
              });
            },
          };
        },
      };
    },
  };
}
