import { Db, MongoClient } from "mongodb";

export class DB {
  db!: Db;
  private client!: MongoClient;

  constructor() {
  }

  async connect() {
    console.log("Connecting to MongoDB", {
      url: process.env["MONGO_URL"],
      ca: process.env["MONGO_CA"]?.substring(0, 100),
      cert: process.env["MONGO_CERT"]?.substring(0, 100),
    });

    if (!process.env["MONGO_URL"]) {
      throw new Error("MONGO_URL is required");
    }

    if (!process.env["MONGO_CA"]) {
      throw new Error("MONGO_CA is required");
    }

    if (!process.env["MONGO_CERT"]) {
      throw new Error("MONGO_CERT is required");
    }

    this.client = new MongoClient(`mongodb+srv://${process.env["MONGO_URL"]}/egdata`, {
      tls: true,
      authMechanism: "MONGODB-X509",
      authSource: "$external",
      tlsCAFile: process.env.MONGO_CA,
      tlsCertificateKeyFile: process.env.MONGO_CERT,
    });

    await this.client.connect();
    this.db = this.client.db("egdata");

    console.log("Connected to MongoDB");
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
    }
  }
}

export const db = new DB();
