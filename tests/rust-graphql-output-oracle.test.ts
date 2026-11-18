import { Hono } from "hono";
import { consola } from "consola";
import { expect, it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { honoMiddleware } from "../src/middlewares/apollo.js";
import { apiCors } from "../src/middlewares/cors.js";
import { edgeCacheHeaders } from "../src/middlewares/edge-cache.js";
import { responseEtag } from "../src/middlewares/response-etag.js";
import { routeTemplate } from "../src/middlewares/route-template.js";
import { ObjectId } from "mongodb";

const mongoCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/db/index.js", () => ({
  db: { db: { collection: (name:string) => ({
    findOne: async (filter: Record<string,unknown>, options = {}) => {
      const id = filter._id instanceof ObjectId ? filter._id.toHexString() : null;
      const result = name === "builds" ? {
        appName: 42, createdAt: "2024-03-02T01:02:03.456789+01:00", updatedAt: 0,
        downloadSizeBytes: "123.5", installedSizeBytes: true,
        metadata: {installationPoolId: false}, technologies: [{technology: "one"}, null, {technology: 7}],
      } : name === "items" ? { id: "123", title: "Selected", endOfSupport: 1, requiresSecureAccount: "invalid" } :
        name === "changelogs_v2" ? { _id: 88, timestamp: "invalid",
          document: id?.endsWith("1") ? {entitlementName:"test", id:"item", title:"Title"} :
                    id?.endsWith("2") ? {artifactId:"artifact", title:"Asset"} : {kind:"unknown"} } : null;
      const query = Object.fromEntries(Object.entries(filter).map(([key,value]) => [key,value instanceof ObjectId ? {$oid:value.toHexString()} : value]));
      mongoCalls.push({call:{collection:name,method:"one",query,options},result});
      return result;
    },
  }) } },
}));

it("compares the canonical Apollo HTTP bridge and cache middleware", async () => {
  const {server} = await import("../src/graphql/index.js");
  const {createLoaders} = await import("../src/graphql/loaders.js");
  const {db} = await import("../src/db/index.js");
  const app = new Hono();
  app.use("*",apiCors(),responseEtag,routeTemplate,edgeCacheHeaders);
  await server.start();
  app.use("/graphql",honoMiddleware(server,{context:async()=>({db:db.db,logger:consola,loaders:createLoaders(db.db)})}));
  const cases:unknown[]=[];
  const record=async(name:string,path:string,method:string,status:number,body?:unknown,headers:Record<string,string>={})=>{
    const request={path,method,headers:{...(body===undefined?{}:{"content-type":"application/json"}),...headers},...(body===undefined?{}:{body})};
    const res=await app.request(path,{method,headers:request.headers,body:body===undefined?undefined:JSON.stringify(body)});
    const response={status:res.status,headers:Object.fromEntries([...res.headers.entries()].filter(([key])=>["content-type","etag","cache-control","cdn-cache-control","vary","allow","x-route-template"].includes(key))),body:await res.text()};
    expect(res.status,name+" "+response.body).toBe(status);
    cases.push({name,request,trace:mongoCalls.splice(0),response});
    return res;
  };
  const get=(query:string)=>"/graphql?"+new URLSearchParams({query});
  try {
    const build = 'build(id:"64c000000000000000000001")';
    const change = (last: string) => 'changelog(id:"64c00000000000000000000'+last+'")';
    await record("scalar-coercion",get(`{${build}{appName createdAt updatedAt downloadSizeBytes installedSizeBytes}}`),"GET",200);
    await record("nested-cache-hint",get(`{${build}{metadata{installationPoolId}}}`),"GET",200);
    await record("nullable-list-elements",get(`{${build}{technologies{technology __typename}}}`),"GET",200);
    await record("coerce-id-selection-alias",get('{item(id:123){value:title __typename endOfSupport}}'),"GET",200);
    await record("partial-field-error",get('{item(id:"123"){id requiresSecureAccount endOfSupport}}'),"GET",200);
    await record("invalid-date-error",get(`{${change("1")}{_id timestamp}}`),"GET",200);
    await record("union-item",get(`{${change("1")}{document{__typename ... on Item{id title}}}}`),"GET",200);
    await record("union-asset",get(`{${change("2")}{document{__typename ... on Asset{artifactId title}}}}`),"GET",200);
    await record("union-invalid",get(`{${change("3")}{_id document{__typename}}}`),"GET",200);
    await record("aliased-type-info",get('{schema:__schema{root:queryType{name fields{name}}} scope:__type(name:"CacheControlScope"){kind enumValues{name}}}'),"GET",200);
    await record("directive-fragments","/graphql","POST",200,{ query: 'query Q($type:String!,$show:Boolean=false){ wanted:__type(name:$type){...Meta} __schema { directives { n:name args{name ...Arg} } } } fragment Meta on __Type { kind name description @include(if:$show) } fragment Arg on __InputValue { __typename type { kind name }}',variables:{type:"DateTime"}});
    await record("merged-introspection-selection",get('{x:__type(name:"CacheControlScope"){values:enumValues{name}} x:__type(name:"CacheControlScope"){values:enumValues{__typename}}}'),"GET",200);
    assertOracle("graphql-output-node",cases);
  } finally {await server.stop();}
});
