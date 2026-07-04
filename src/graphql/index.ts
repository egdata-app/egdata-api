import { ApolloServer } from "@apollo/server";
import { type ConsolaInstance, LogLevels } from "consola";
import { GraphQLDateTime, GraphQLJSON } from "graphql-scalars";
import type { Db } from "mongodb";
import type { createLoaders } from "./loaders.js";
import builds from "./resolvers/build.js";
import changelogs from "./resolvers/changelog.js";
import items from "./resolvers/item.js";
import offers from "./resolvers/offer.js";
import profiles from "./resolvers/profile.js";
import sandboxes from "./resolvers/sandbox.js";
import { typeDefs } from "./typedefs.js";

const resolvers = {
  Date: GraphQLDateTime,
  JSON: GraphQLJSON,
};

export type Context = {
  db: Db;
  logger: ConsolaInstance;
  loaders: ReturnType<typeof createLoaders>;
};

export const server = new ApolloServer<Context>({
  typeDefs,
  resolvers: [
    offers,
    items,
    builds,
    changelogs,
    sandboxes,
    profiles,
    resolvers,
  ],
  introspection: true,
  plugins: [
    {
      async requestDidStart(requestContext) {
        const logger = requestContext.contextValue.logger;
        if (logger.level < LogLevels.debug) {
          return;
        }

        const query = requestContext.request.query?.replace(/\s+/g, " ").trim();

        // Skip logging introspection queries to keep logs clean
        if (query?.includes("IntrospectionQuery")) {
          return;
        }

        logger.debug(`[GraphQL Query]: ${query}`);

        const variables = requestContext.request.variables;
        if (variables && Object.keys(variables).length > 0) {
          logger.debug(`[GraphQL Variables]: ${JSON.stringify(variables)}`);
        }

        return {
          async executionDidStart() {
            return {
              willResolveField({ info }) {
                const path = `${info.parentType.name}.${info.fieldName}`;
                // Optional: Only log your custom resolvers, not every leaf field
                // For now, logging all to satisfy "which resolvers is using"
                logger.debug(`[GraphQL Resolver]: ${path}`);
              },
            };
          },
        };
      },
    },
  ],
});
