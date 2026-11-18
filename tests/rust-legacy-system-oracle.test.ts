import { afterAll, expect, it, vi } from "vitest";
import { assertOracle, captureResponse } from "../rust/oracles/record.js";
import { readFileSync } from "node:fs";

type Input = {failAt?:number,rows?: unknown[], collections?:Record<string,unknown[]>, counts?: Record<string,number>, cache?: unknown, search?:unknown, fail?:string};
const io=vi.hoisted(()=>({input:{} as Input, trace:[] as unknown[]}));
function call(call:Record<string,unknown>, result:unknown) {
  if(io.input.failAt===io.trace.length || (io.input.fail && io.input.fail===(call.service??call.collection))){
    io.trace.push({call,error:true});throw Error("fixture read failed");
  }
  io.trace.push({call,result:encoded(result)});return result;
}
function encoded(value:unknown):unknown {
  if(value instanceof RegExp)return {$regularExpression:{pattern:value.source,options:value.flags}};
  if(value instanceof Date)return {$date:value.toISOString()};
  if(Array.isArray(value))return value.map(encoded);
  if(value && typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,encoded(v)]));
  return value;
}
function countFilter(query:Record<string,unknown>):unknown {
  if (!query.creationDate) return encoded(query);
  const dates = query.creationDate as Record<string,Date>;
  const years = ["$gte","$lt"].map(key=>{
    const date=dates[key];
    expect(date.getTime()).toEqual(new Date(date.getFullYear(),0,1).getTime());
    return date.getFullYear();
  });
  return {localYears:years};
}
vi.mock("../src/db/index.js",()=>({db:{db:{
  command:async()=>{call({method:"ping",service:"mongo"},true);return {ok:1}},
  collection:(collection:string)=>({
    find:(query={},options:Record<string,unknown>={})=>({
      sort(sort:unknown){options.sort=sort;return this},limit(limit:number){options.limit=limit;return this},
      toArray:async()=>call({collection,method:"many",query:encoded(query),options:encoded(options)},io.input.collections?.[collection]??io.input.rows??[])
    }),
    findOne:async(query={},options={})=>call({collection,method:"one",query:encoded(query),options:encoded(options)},(io.input.collections?.[collection]??io.input.rows)?.[0]??null),
    aggregate:(pipeline:unknown[])=>({toArray:async()=>call({collection,method:"aggregate",query:encoded(pipeline),options:{}},io.input.collections?.[collection]??io.input.rows??[])}),
    countDocuments:async(query={})=>call({collection,method:"count",query:countFilter(query),options:{}},io.input.counts?.[collection]??0),
  })
}}}));
vi.mock("../src/clients/opensearch.js",()=>({opensearch:{search:async({index,body}:{index:string,body:unknown})=>({body:call({service:"opensearch",method:"search",index,body},io.input.search??{})})}}));
vi.mock("../src/clients/redis.js",()=>({default:{get:async(key:string)=>{expect(key.startsWith("q:")).toBe(true);const hit=call({method:"get",key:key.slice(2)},io.input.cache??null);return hit===null?null:JSON.stringify(hit)},ping:async()=>{call({method:"ping",service:"redis"},true);return "PONG"}}}));
vi.mock("../src/clients/response-cache.js",()=>({default:{
  get:async(key:string)=>{call({method:"get",key},io.input.cache??null);return io.input.cache===undefined?null:JSON.stringify(io.input.cache)},
  set:async(key:string,value:string,_mode:string,ttl:number)=>call({method:"set",key,...(value===undefined?{}:{payload:JSON.parse(value)}),ttl},null),
},disconnectResponseCache:()=>{}}));

it("replays the unversioned system and statistics routes from the full Node app",async()=>{
  const {app}=await import("../src/index.js");
  vi.useFakeTimers({toFake:["Date"]});
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  const cases:unknown[]=[];
  type RequestCase={method:string,path:string,headers?:Record<string,string>,rawBody?:string,rawBodyBytes?:number[]};
  const record=async(name:string,request:RequestCase,input:Input={},status=200)=>{
    io.input=input;io.trace=[];
    const body = request.rawBodyBytes ? Uint8Array.from(request.rawBodyBytes) : request.rawBody;
    const response=await app.request(request.path,{method:request.method,headers:request.headers,body});
    expect(response.status,name).toBe(status);
    cases.push({name,request,trace:io.trace,response:await captureResponse(response)});
  };
  const get=(path:string,headers?:Record<string,string>)=>({method:"GET",path,headers});
  for(const path of ["/countries?extra=1","/regions","/region","/robots.txt","/ping","/health?verbose=yes"])
    await record("legacy "+path,get(path));
  await record("health with Redis unavailable",get("/health"),{fail:"redis"},500);
  await record("health with Mongo unavailable",get("/health"),{fail:"mongo"},500);
  await record("region from first decoded cookie",get("/region",{cookie:'other=x; EGDATA_COUNTRY="%45S"; EGDATA_COUNTRY=CA'}));
  await record("query wins over cookie",get("/region?country=CA&country=ES",{cookie:"EGDATA_COUNTRY=GB"}));
  await record("case-sensitive unknown country",get("/region?country=es"),{},404);
  await record("legacy missing route",get("/unregistered-fixture"),{},404);
  await record("legacy unmatched method",{path:"/region",method:"POST"},{},404);
  await record("empty country overrides cookie",get("/region?country=",{cookie:"EGDATA_COUNTRY=US"}),{},404);
  await record("tag groups",get("/tags?group=event&group=wrong"),{rows:[{id:"101",name:"Event"}]});
  await record("all tags",get("/tags"));
  await record("offer slug",get("/offer-by-slug/test"),{rows:[{id:"offer-one",title:"Sample"}]});
  await record("no matching slug",get("/offer-by-slug/missing"),{},404);
  await record("hydrate invalid", {method:"POST",path:"/catalog/hydrate",rawBody:"{"},{},400);
  await record("hydrate declared oversized",{method:"POST",path:"/catalog/hydrate",headers:{"content-length":"262145"},rawBody:"{}"},{},413);
  for (const path of ["/sitemap.xml","/items-sitemap.xml"]) {
    await record("index "+path,get(path),{counts:{offers:502,items:1001}});
    await record("page "+path,get(path+"?page=2"),{rows:[{id:"game",lastModifiedDate:new Date("2025-05-02T00:00:00Z")}]});
  }
  await record("promotion sitemap",get("/promotions-sitemap.xml"),{rows:[{id:"event1"},{id:"event2"}]});
  await record("swagger ui",get("/ui"));
  for(const method of ["GET","POST"]) await record("retired search "+method,{method,path:"/search"},{},410);
  await record("search tags",get("/search/tags"),{rows:[{id:"tag",status:"ACTIVE"}]});
  await record("search offer types",get("/search/offer-types"),{rows:[{_id:"GAME",count:2},{_id:null,count:5},{_id:"",count:8}]});
  await record("search developers",get("/search/developers?query=Studio"),{rows:[{_id:"Studio",count:3}]});
  await record("search publishers",get("/search/publishers"),{rows:[{_id:"Company",count:2}]});
  await record("saved query",get("/search/saved-key"),{cache:{query:"game"}});
  await record("missing saved query",get("/search/absent"),{},404);
  const counts={sandboxes:3,products:8,items:5,offers:7};
  await record("legacy stats counts",get("/stats"),{counts});
  await record("legacy stats failed sandbox count",get("/stats"),{counts,fail:"sandboxes"});
  await record("legacy stats failed products count",get("/stats"),{counts,fail:"products"});
  await record("legacy stats cached",get("/stats"),{cache:{offers:12}});
  await record("legacy stats homepage",get("/stats/homepage",{cookie:"EGDATA_COUNTRY=ES"}),{counts});
  await record("legacy stats homepage unknown region",get("/stats/homepage?country=XX"),{},404);
  for(const type of ["releases","creations"]){
    for(const period of ["monthly","yearly"]){
      const rows=[{year:2026,...period==="monthly"?{month:11}:{},[type]:5}];
      await record("legacy "+type+" "+period,get(`/stats/${type}/${period}`),{rows});
    }
  }
  await record("legacy stats chart cache",get("/stats/creations/yearly"),{cache:[{year:2026,creations:2}]});
  assertOracle("legacy-system-http-node",cases);
  cases.length=0;
  const sample={id:"offer",namespace:"ns",offerType:"BASE_GAME",tags:[{id:"tag",name:"Strategy"}],items:[{id:"item"}]};
  const document={_id:"offer",foo:"value"};
  const collections={
    offers:[sample,{id:"other",namespace:"different"}],
    tags:[{id:"tag",name:"Strategy"}], items:[{id:"item",customAttributes:[]}],
    offersubitems:[{_id:"offer",subItems:[{id:"item2"}]}],assets:[{artifactId:"app",itemId:"item"}],
    mappings:[document],media:[document],igdb:[{offerId:"offer",gameId:99}],freegames:[{id:"offer"}],
    hltbs:[{_id:"offer",hltbId:"12345"}],ratings:[{_id:"product-slug",average:4.5}],
    sandboxes:[{_id:"ns",parent:"product",ageGatings:{ESRB:"T",PEGI:"12"}}],
    products:[{_id:"product",slug:"product-slug"}],game_positions:[{collectionId:"daily",position:9},{collectionId:"daily",position:5}],
    collections_v2:[{_id:"daily",name:"Daily"}],achievementsets:[{sandboxId:"ns",isBase:true}],
    franchises:[{name:"Series",offers:["offer","other"]},{name:"Single",offers:["offer"]}],
    builds:[{_id:"build-1",appName:"app",labelName:"Live-Windows",hash:"hash",buildVersion:"1.0"}],
  };
  const metadata=["mappings","media","igdb","giveaways","tops","genres","ratings","hltb","achievements","age-rating","items","assets","features","technologies","builds","franchises","collections/daily"];
  const post=(path:string,body:unknown)=>({method:"POST",path,rawBody:JSON.stringify(body)});
  await record("legacy single offer",get("/offers/offer"),{rows:[{...sample,customAttributes:[{key:"site",value:"home"}]}]});
  await record("legacy single offer missing attributes",get("/offers/offer"),{rows:[sample]});
  await record("legacy missing single offer",get("/offers/missing"),{},404);
  await record("legacy cached offer",get("/offers/offer"),{cache:{id:"cached"}});
  await record("legacy offer invalid locale",get("/offers/offer?locale=invalid%20tag"),{},400);
  await record("legacy resolve offer slugs",post("/offers/slugs",{slugs:["app","absent","app",7]}),{rows:[{id:"offer",namespace:"ns",offerMappings:[{pageSlug:"app/home"}]}]});
  await record("legacy no slugs",post("/offers/slugs",{slugs:[]}),{},400);
  await record("legacy offer existence",post("/offers/exists",{offers:["z","missing","a","missing"]}),{rows:[{id:"a"},{id:"z"}]});
  await record("legacy offer polls",get("/offers/offer/polls"),{collections:{...collections,ratings_polls:[{_id:"ns",polls:[1]}]}});
  await record("legacy no offer polls",get("/offers/offer/polls"),{collections});
  await record("legacy offer events",get("/offers/events"),{collections});
  for(const name of metadata){
    const input=name==="technologies"?{...collections,builds:[{doc:{technologies:[{technology:"UE5",section:"engines"},{technology:"UE5",section:"engine"}]}}]}:collections;
    await record("legacy offer "+name,get("/offers/offer/"+name),{collections:input});
    const status=["giveaways","tops","franchises"].includes(name)?200:404;
    await record("legacy offer missing "+name,get("/offers/missing/"+name),{},status);
  }
  await record("legacy offer age rating for country cookie",get("/offers/offer/age-rating?single=false",{cookie:"EGDATA_COUNTRY=US"}),{collections});
  await record("legacy offer cache before lookup",get("/offers/offer/hltb"),{cache:{_id:"offer",hltbId:"cached"}});
  await record("legacy offer cache after lookup",get("/offers/offer/ratings"),{collections,cache:{average:4.5}});
  const fresh = async (name: string, request: RequestCase, input: Input) => {
    await record(name, request, input);
    const trace = [...io.trace] as {
      call: { collection?: string; method: string };
    }[];
    for (const [index, { call }] of trace.entries()) {
      await record(
        [name, call.collection ?? "cache", call.method, index].join(" "),
        request,
        { ...input, failAt: index },
        500,
      );
    }
  };
  const warmBefore = [
    "mappings",
    "giveaways",
    "tops",
    "hltb",
    "age-rating",
    "items",
    "assets",
    "builds",
    "franchises",
    "polls",
  ];
  for (const field of warmBefore)
    await record(
      "cache hit before Mongo " + field,
      get("/offers/offer/" + field),
      { cache: ["warm"] },
    );
  await record(
    "achievements cache after offer",
    get("/offers/offer/achievements"),
    { collections, cache: ["warm"] },
  );
  for (const field of [...metadata, "polls"]) {
    const graph = {
      ...collections,
      ...(field === "technologies"
        ? { builds: [{ doc: { technologies: [{ technology: "UE5" }] } }] }
        : {}),
      ratings_polls: [{ _id: "ns", polls: [] }],
    };
    await fresh("offer boundary " + field, get("/offers/offer/" + field), {
      collections: graph,
    });
  }
  await fresh("single offer boundaries", get("/offers/offer"), { collections });
  await fresh("offer events boundaries", get("/offers/events"), {
    collections,
  });
  await fresh(
    "offer exists boundaries",
    post("/offers/exists", { offers: ["offer"] }),
    { collections },
  );
  await fresh(
    "offer slugs boundaries",
    post("/offers/slugs", { slugs: ["slug"] }),
    { collections },
  );
  await record(
    "malformed technology group",
    get("/offers/offer/technologies"),
    { collections },
    500,
  );
  for (const field of ["ratings", "polls", "age-rating"])
    await record(
      "missing sandbox " + field,
      get("/offers/offer/" + field),
      { collections: { ...collections, sandboxes: [] } },
      404,
    );
  await record(
    "missing ratings product",
    get("/offers/offer/ratings"),
    { collections: { ...collections, products: [] } },
    404,
  );
  await record(
    "missing ratings value",
    get("/offers/offer/ratings"),
    { collections: { ...collections, ratings: [] } },
    404,
  );
  await record(
    "missing age gatings",
    get("/offers/offer/age-rating"),
    { collections: { ...collections, sandboxes: [{}] } },
    404,
  );
  await record(
    "missing regional rating",
    get("/offers/offer/age-rating?single=1&country=US"),
    { collections: { ...collections, sandboxes: [{ ageGatings: {} }] } },
    404,
  );
  for (const value of [0, null, "00000", "", false])
    await record(
      "hltb sentinel " + JSON.stringify(value),
      get("/offers/offer/hltb"),
      { collections: { ...collections, hltbs: [{ hltbId: value }] } },
      404,
    );
  await record("empty achievements", get("/offers/offer/achievements"), {
    collections: { ...collections, achievementsets: [] },
  });
  await record(
    "collection with missing name",
    get("/offers/offer/collections/daily"),
    { collections: { ...collections, collections_v2: [{}] } },
  );
  await record(
    "missing collections game",
    get("/offers/offer/collections/daily"),
    { collections: { ...collections, game_positions: [] } },
    404,
  );
  await record(
    "absent collection",
    get("/offers/offer/collections/daily"),
    { collections: { ...collections, collections_v2: [] } },
    404,
  );
  await record("positions missing values", get("/offers/offer/tops"), {
    collections: {
      ...collections,
      game_positions: [
        { position: 3 },
        { collectionId: "a", position: 1 },
        { collectionId: "a" },
      ],
    },
  });
  await record(
    "slugs alternate fields",
    post("/offers/slugs", {
      slugs: ["url", "product", "custom", "fallback", "missing-id"],
    }),
    {
      rows: [
        { id: "u", urlSlug: "url/home" },
        { id: "p", productSlug: "product" },
        {
          id: "custom",
          customAttributes: [
            { key: "com.epicgames.app.productSlug", value: "custom" },
          ],
        },
        {
          id: "k",
          customAttributes: [{ key: "slug", value: "fallback/home" }],
        },
        { offerMappings: [{ pageSlug: "missing-id" }] },
      ],
    },
  );
  await record(
    "technologies with scalar and missing fields",
    get("/offers/offer/technologies"),
    {
      collections: {
        ...collections,
        builds: [
          { doc: {} },
          { doc: { technologies: { technology: "Solo" } } },
          {
            doc: {
              technologies: [
                false,
                null,
                0,
                "",
                {},
                { technology: null },
                { technology: "Solo" },
              ],
            },
          },
        ],
      },
    },
  );
  for (const val of [false, "", 0]) {
    await record(
      "falsey age map " + JSON.stringify(val),
      get("/offers/offer/age-rating"),
      { collections: { ...collections, sandboxes: [{ ageGatings: val }] } },
      404,
    );
    await record(
      "falsey single rating " + JSON.stringify(val),
      get("/offers/offer/age-rating?single=1&country=US"),
      {
        collections: {
          ...collections,
          sandboxes: [{ ageGatings: { ESRB: val } }],
        },
      },
      404,
    );
  }
  for (const field of ["slugs", "exists"]) {
    await record(
      field + " malformed json",
      { method: "POST", path: "/offers/" + field, rawBody: "{" },
      {},
      500,
    );
    await record(field + " null body", post("/offers/" + field, null), {}, 500);
  }
  for (const field of ["genres", "features"])
    await record(
      "missing tag array " + field,
      get("/offers/offer/" + field),
      { collections: { ...collections, offers: [{ ...sample, tags: null }] } },
      500,
    );
  for (const field of ["items", "features", "assets", "builds", "technologies"])
    await record(
      "missing item array " + field,
      get("/offers/offer/" + field),
      { collections: { ...collections, offers: [{ ...sample, items: null }] } },
      500,
    );
  await record(
    "invalid subitem array",
    get("/offers/offer/items"),
    {
      collections: {
        ...collections,
        offersubitems: [{ _id: "offer", subItems: null }],
      },
    },
    500,
  );
  await record(
    "offer build missing id",
    get("/offers/offer/builds"),
    { collections: { ...collections, builds: [{}] } },
    500,
  );
  await record(
    "franchises with missing offer identity",
    get("/offers/offer/franchises"),
    {
      collections: {
        ...collections,
        offers: [{ id: "offer" }, { namespace: "other" }],
      },
    },
  );
  await record("poll offer missing", get("/offers/absent/polls"), {}, 404);
  await record(
    "empty poll cannot be cached",
    get("/offers/offer/polls"),
    { collections, failAt: 4 },
    500,
  );
  await record(
    "translation store unavailable",
    get("/offers/offer?locale=fr"),
    { collections, fail: "egs_localizations" },
    500,
  );
  assertOracle("legacy-offers-http-node",cases);
  cases.length=0;
  const hit={_source:{id:"a",namespace:"ns",title:"Example",offerType:"BASE_GAME",customAttributes:[{key:"test",value:"value"}],prices:{US:{offerId:"a",currency:"USD"}}}};
  const search={hits:{hits:[hit],total:{value:1}},aggregations:{offerType:{buckets:[]},tags:{buckets:["t"]},extra:1},took:3,timed_out:false};
  const v2="/search/v2/search";
  for(const suffix of ["","?facets=minimal&title=Game","?facets=none&onSale=false&limit=2&page=3","?tags=b,a,a&technologies%5B%5D=RPG&priceMin=2&isLowestPrice=true&sortBy=upcoming","?sortBy=releaseDate&sortDir=asc","?pastGiveaways=1&expand=full&sortBy=giveawayDate","?categories=apps&refundType=FULL&seller=ID&isCodeRedemptionOnly=1&excludeBlockchain=1&sortBy=discountPercent"]) {
    await record("legacy search "+suffix,get(v2+suffix),{search:structuredClone(search)});
  }
  await record("legacy search fractional prices",get(v2+"?priceMin=1.125&priceMax=2.875"),{search:structuredClone(search)});
  await record("legacy search warm cache",get(v2),{cache:{total:2,offers:[],meta:{cached:false}}});
  await record("legacy search reroutes", {...post(v2+"?expand=full",{tags:["a,b","a","b"],facets:"minimal",page:0,limit:150,unknown:1}),headers:{cookie:"EGDATA_COUNTRY=DE"}},{},303);
  for(const [name,body] of [["null",null],["invalid filters",{seller:1,onSale:null,sortBy:"wrong",page:1.5,tags:[" "]}],["invalid technologies",{technologies:[""],page:"invalid"}]]) await record("legacy v2 "+name,post(v2,body),{},400);
  await record("legacy search NaN",get(v2+"?page=no"),{},400);
  await record("legacy search unavailable",get(v2),{fail:"opensearch"},500);
  const searchResult = { hits: { hits: [], total: 0 } };
  for (const [name, suffix] of [
    ["radices", "page=0b11&limit=0O12&priceMin=0x1ffffffffffffffff&priceMax=0x100000000000000000000000000000001"],
    ["oversized-radix", "priceMax=0b1" + "0".repeat(200)],
    ["unicode-trim", "limit=%EF%BB%BF0x0a%C2%A0&page=%20&priceMin=-0&priceMax=.015625"],
    ["duplicate-scalars", "title=first&title=second&priceMin=3&priceMin=no&limit=4&limit=bogus&onSale=true&onSale=no"],
    ["mixed-list-styles", "tags=z,b&tags%5B%5D=c%2Cb&tags%5B%5D=b&tags%5B%5D=b&tags%5B%5D=%20a%20&categories=j,i&categories=z&technologies=,,"],
    ["largest-safe-page", "page=9007199254740991&limit=99"],
    ["clamp", "limit=-3&page=0&priceMin=-2e-2&priceMax=1e127"],
  ]) await record("search inputs "+name,get(v2+"?facets=none&"+suffix),{search:searchResult});
  for (const [name, suffix] of [
    ["infinite", "priceMax=-Infinity&priceMin=Infinity&page=1e309&limit=%2BInfinity"],
    ["invalid-numbers", "priceMax=0x_1&priceMin=0b2&page=inf&limit=-0x10"],
    ["huge-radix", "priceMin=0x1"+"0".repeat(280)],
    ["unsafe-integers", "limit=-0x0d&page=9007199254740992"],
    ["bounds", "page=-9007199254740992&limit=0x10000000000000000"],
    ["multiple-schema-issues", "priceMin=bad&page=3.1&sortDir=no&limit=1.5&onSale=maybe&tags%5B%5D=%20&tags%5B%5D=+&sortBy=bad"],
    ["technology-precedence", "tags%5B%5D=%20&technologies=valid&technologies%5B%5D=%20&priceMin=bad"],
    ["first-invalid", "page=bad&page=1&onSale=maybe&onSale=true"],
  ]) await record("search inputs "+name,get(v2+"?"+suffix),{},400);
  for (const [name, body, status] of [
    ["malformed",'{"limit":2,',400], ["empty","",400], ["trailing-comma",'{"page":1,}',400],
    ["array","[]",400], ["string",'"text"',400], ["boolean","false",400], ["raw-nan",'{"limit":NaN}',400],
    ["non-finite",'{"page":1e999,"limit":-1e999,"price":{"min":1e999,"max":"Infinity"}}',400],
    ["ignored-overflow",'{"title":"game","ignored":{"both":[1e999,-1e999]}}',303],
    ["overwritten-keys",'{"page":1e999,"page":1,"price":{"max":2,"max":3}}',303],
    ["mistyped-overflows",'{"title":1e999,"tags":[-1e999,{}],"sortBy":1e999,"price":1e999}',400],
    ["false-numbers",'{"price":{"min":"NaN","max":"Infinity"},"limit":"-Infinity","page":"1"}',400],
    ["top-level-overflow","1e999",400],
    ["bom","\uFEFF"+JSON.stringify({title:"game"}),303],
    ["technologies-first",JSON.stringify({title:3,tags:[""],technologies:[null],"page":{}}),400],
    ["schema-issue-order",JSON.stringify({price:{max:"x",min:[]},page:[],limit:1.25,sortDir:0,sortBy:false,isLowestPriceEver:2,onSale:null,excludeBlockchain:{},refundType:8,publisherDisplayName:[],developerDisplayName:false,seller:{},customAttributes:[{}, " "],categories:[null,""],tags:["",false],offerType:9,title:[]}),400],
    ["normalized-redirect",JSON.stringify({facets:{},unknown:2,price:{min:0.00000001,max:2.125,unknown:true},tags:["𐀀","\uE000","a,b","a,b"," B "],title:" hi ",limit:99,page:3}),303],
  ] as const) await record("search inputs "+name,{method:"POST",path:v2,rawBody:body,headers:{"content-type":"application/json"}},{},status);
  await record("search inputs bad locale before corrupt JSON",{method:"POST",path:v2+"?locale=not_a_locale",rawBody:"{"},{},400);
  await record("search inputs malformed UTF-8 in title", {
    method:"POST", path:v2, rawBodyBytes:[...Buffer.from('{"title":"'),0xff,...Buffer.from('"}')],
  },{},303);
  await record("search inputs malformed UTF-8 outside string", {
    method:"POST", path:v2, rawBodyBytes:[...Buffer.from('{"title":'),0xff,...Buffer.from('}')],
  },{},400);
  assertOracle("legacy-search-http-node",cases);
  const contract=JSON.parse(readFileSync(new URL("../openapi/egdata.openapi.json",import.meta.url),"utf8"));
  for(const path of ["/open-api.json","/doc"])
    expect(await (await app.request(path)).text()).toEqual(JSON.stringify(contract));
});
afterAll(async()=>{vi.useRealTimers();const {server}=await import("../src/graphql/index.js");await server.stop()});
