import type { GraphQLResolveInfo } from '@graphql-tools/utils';
import { parseResolveInfo } from 'graphql-parse-resolve-info';

export function buildProjection(info: GraphQLResolveInfo, name: string) {
    const parsed = parseResolveInfo(info);
    const fields = parsed?.fieldsByTypeName[name] ?? {};
    const projection = Object.fromEntries(Object.keys(fields).map(k => [k, 1]));
    
    // Always include identifying fields for resolvers
    projection.id = 1;
    projection._id = 1;
    
    return projection;
}
