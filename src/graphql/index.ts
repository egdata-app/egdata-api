import { ApolloServer } from "@apollo/server";
import { typeDefs } from "./typedefs.js";
import offers from "./resolvers/offer.js";
import items from "./resolvers/item.js";
import builds from "./resolvers/build.js";
import changelogs from "./resolvers/changelog.js";
import sandboxes from "./resolvers/sandbox.js";
import profiles from "./resolvers/profile.js";
import type { ConsolaInstance } from "consola";
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { createLoaders } from './loaders.js';

const resolvers = {
    Date: GraphQLDateTime,
    JSON: GraphQLJSON
};

export type Context = {
    db: any
    logger: ConsolaInstance
    loaders: ReturnType<typeof createLoaders>
}

export const server = new ApolloServer<Context>({
    typeDefs,
    resolvers: [offers, items, builds, changelogs, sandboxes, profiles, resolvers],
    introspection: true,
    plugins: [
        {
            async requestDidStart(requestContext) {
                const logger = requestContext.contextValue.logger;
                const query = requestContext.request.query?.replace(/\s+/g, ' ').trim();
                
                // Skip logging introspection queries to keep logs clean
                if (query?.includes('IntrospectionQuery')) {
                    return;
                }

                logger.info(`[GraphQL Query]: ${query}`);
                
                const variables = requestContext.request.variables;
                if (variables && Object.keys(variables).length > 0) {
                    logger.info(`[GraphQL Variables]: ${JSON.stringify(variables)}`);
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
