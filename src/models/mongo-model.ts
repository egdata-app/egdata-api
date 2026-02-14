type Document = Record<string, any>;
type Filter<T> = Record<string, any>;
type FindOptions = Record<string, any>;
type OptionalUnlessRequiredId<T> = T;
type Sort = Record<string, any>;
type CollationOptions = Record<string, any>;
type UpdateFilter<T> = Record<string, any>;
type Collection<T> = {
  find: (filter?: any, options?: any) => { toArray: () => Promise<T[]> };
  findOne: (filter?: any, options?: any) => Promise<T | null>;
  estimatedDocumentCount: () => Promise<number>;
  countDocuments: (filter?: any, options?: any) => Promise<number>;
  distinct: (field: string, filter?: any) => Promise<any[]>;
  aggregate: (pipeline: any[]) => { toArray: () => Promise<any[]> };
  insertOne: (doc: any) => Promise<any>;
  insertMany: (docs: any[]) => Promise<any>;
  updateOne: (filter: any, update: any, options?: any) => Promise<any>;
  updateMany: (filter: any, update: any, options?: any) => Promise<any>;
  deleteOne: (filter: any) => Promise<any>;
  deleteMany: (filter: any) => Promise<any>;
  findOneAndUpdate: (filter: any, update: any, options?: any) => Promise<T | null>;
};

type Projection = Document | string | undefined;

const wrapDoc = <T>(doc: T | null): (T & { toObject: () => T }) | null => {
  if (!doc || typeof doc !== "object") {
    return doc as (T & { toObject: () => T }) | null;
  }

  const value = doc as T & { toObject?: () => T };
  if (typeof value.toObject !== "function") {
    Object.defineProperty(value, "toObject", {
      value: () => doc,
      enumerable: false,
      writable: false,
    });
  }

  return value as T & { toObject: () => T };
};

const parseSelectProjection = (select: string): Document => {
  const projection: Document = {};
  for (const field of select.split(" ").map((item) => item.trim()).filter(Boolean)) {
    if (field.startsWith("-")) {
      projection[field.slice(1)] = 0;
      continue;
    }
    projection[field] = 1;
  }
  return projection;
};

const normalizeProjection = (projection: Projection): Document | undefined => {
  if (!projection) {
    return undefined;
  }
  if (typeof projection === "string") {
    return parseSelectProjection(projection);
  }
  return projection;
};

class QueryOne<T extends Document> implements PromiseLike<(T & { toObject: () => T }) | null> {
  constructor(private readonly rawPromise: Promise<T | null>) {}

  then<TResult1 = (T & { toObject: () => T }) | null, TResult2 = never>(
    onfulfilled?:
      | ((value: (T & { toObject: () => T }) | null) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.rawPromise.then(
      (value) => (onfulfilled ? onfulfilled(wrapDoc(value)) : (wrapDoc(value) as TResult1)),
      onrejected ?? undefined,
    );
  }

  lean(): Promise<T | null> {
    return this.rawPromise;
  }
}

class QueryMany<T extends Document> implements PromiseLike<Array<T & { toObject: () => T }>> {
  private projection?: Document;
  private options: FindOptions;

  constructor(
    private readonly collection: Collection<T>,
    private readonly filter: Filter<T>,
    projection?: Projection,
    options?: FindOptions,
  ) {
    this.projection = normalizeProjection(projection);
    this.options = { ...(options ?? {}) };
  }

  select(projection: string | Document): this {
    this.projection = normalizeProjection(projection);
    return this;
  }

  sort(sort: Sort): this {
    this.options.sort = sort;
    return this;
  }

  limit(limit: number): this {
    this.options.limit = limit;
    return this;
  }

  skip(skip: number): this {
    this.options.skip = skip;
    return this;
  }

  collation(collation: CollationOptions): this {
    this.options.collation = collation;
    return this;
  }

  async lean(): Promise<T[]> {
    return (await this.collection
      .find(this.filter, {
        ...this.options,
        projection: this.projection,
      })
      .toArray()) as T[];
  }

  then<TResult1 = Array<T & { toObject: () => T }>, TResult2 = never>(
    onfulfilled?:
      | ((value: Array<T & { toObject: () => T }>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.lean().then(
      (rows) => {
        const wrapped = rows.map((row) => wrapDoc(row) as T & { toObject: () => T });
        return onfulfilled ? onfulfilled(wrapped) : (wrapped as TResult1);
      },
      onrejected ?? undefined,
    );
  }
}

class AggregateQuery<T extends Document> implements PromiseLike<Array<T & { toObject: () => T }>> {
  constructor(private readonly promise: Promise<T[]>) {}

  exec(): Promise<Array<T & { toObject: () => T }>> {
    return this.promise.then((rows) =>
      rows.map((row) => wrapDoc(row) as T & { toObject: () => T }),
    );
  }

  then<TResult1 = Array<T & { toObject: () => T }>, TResult2 = never>(
    onfulfilled?:
      | ((value: Array<T & { toObject: () => T }>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

type FindManyOptions = FindOptions & {
  sort?: Sort;
  limit?: number;
  skip?: number;
};

export const createMongoModel = <T extends Document>(
  collectionFactory: () => Collection<T>,
) => {
  return {
    find(filter: Filter<T> = {} as Filter<T>, projection?: Projection, options?: FindManyOptions) {
      return new QueryMany(collectionFactory(), filter, projection, options);
    },

    findOne(filter: Filter<T> = {} as Filter<T>, projection?: Projection, options?: FindOptions) {
      const normalizedProjection = normalizeProjection(projection);
      return new QueryOne(
        collectionFactory().findOne(filter, {
          ...(options ?? {}),
          projection: normalizedProjection,
        }),
      );
    },

    findById(id: string, projection?: Projection, options?: FindOptions) {
      return this.findOne({ _id: id } as Filter<T>, projection, options);
    },

    exists(filter: Filter<T>) {
      return collectionFactory().findOne(filter, { projection: { _id: 1 } as Document });
    },

    countDocuments(filter: Filter<T> = {} as Filter<T>, options?: Record<string, any>) {
      return collectionFactory().countDocuments(filter, options);
    },

    estimatedDocumentCount() {
      return collectionFactory().estimatedDocumentCount();
    },

    distinct(field: string, filter: Filter<T> = {} as Filter<T>) {
      return collectionFactory().distinct(field, filter);
    },

    aggregate<U extends Document = T>(pipeline: Document[]) {
      return new AggregateQuery<U>(collectionFactory().aggregate(pipeline).toArray());
    },

    async create(doc: OptionalUnlessRequiredId<T>) {
      const payload = {
        ...doc,
      } as T;

      if (!("createdAt" in payload)) {
        (payload as Document).createdAt = new Date();
      }
      if (!("updatedAt" in payload)) {
        (payload as Document).updatedAt = new Date();
      }

      await collectionFactory().insertOne(payload as OptionalUnlessRequiredId<T>);
      return wrapDoc(payload) as T & { toObject: () => T };
    },

    updateOne(filter: Filter<T>, update: UpdateFilter<T> | Document, options?: Document) {
      return collectionFactory().updateOne(filter, update as UpdateFilter<T>, options);
    },

    updateMany(filter: Filter<T>, update: UpdateFilter<T> | Document, options?: Document) {
      return collectionFactory().updateMany(filter, update as UpdateFilter<T>, options);
    },

    deleteOne(filter: Filter<T>) {
      return collectionFactory().deleteOne(filter);
    },

    deleteMany(filter: Filter<T>) {
      return collectionFactory().deleteMany(filter);
    },

    insertMany(docs: OptionalUnlessRequiredId<T>[]) {
      return collectionFactory().insertMany(docs);
    },

    async findOneAndUpdate(
      filter: Filter<T>,
      update: UpdateFilter<T> | Document,
      options?: { new?: boolean; upsert?: boolean },
    ) {
      const result = await collectionFactory().findOneAndUpdate(filter, update as UpdateFilter<T>, {
        returnDocument: options?.new ? "after" : "before",
        upsert: options?.upsert,
      });
      return wrapDoc(result) as (T & { toObject: () => T }) | null;
    },
  };
};
