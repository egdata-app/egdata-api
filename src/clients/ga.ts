import { consola } from "../utils/logger.js";

interface GaOptions {
  id: string;
  secret: string;
}

interface TrackOpts {
  event: string;
  location: string;
  params: {
    [key: string]: string | number;
  };
  session: {
    id: string;
    startedAt: number;
    lastActiveAt: number;
  };
  userId: string;
}

export class GaClient {
  constructor(private options: GaOptions) {}

  async track(opts: TrackOpts) {
    if (!this.options.secret) {
      consola.warn("No GA secret provided, skipping GA tracking");
      return;
    }

    const body = {
      client_id: opts.userId,
      user_id: opts.userId,
      events: [
        {
          name: opts.event,
          params: {
            page_location: opts.location,
            ...opts.params,
            session_id: opts.session.id,
            timestamp_millis: opts.session.lastActiveAt,
            engagement_time_msec:
              opts.session.lastActiveAt - opts.session.startedAt,
          },
        },
      ],
    };

    const url = new URL("https://www.google-analytics.com/mp/collect");
    url.searchParams.set("measurement_id", this.options.id);
    url.searchParams.set("api_secret", this.options.secret);

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `GA track request failed: ${response.status} ${response.statusText}`,
          );
        }
      })
      .catch((err) => {
        console.error(err);
      });
  }
}

export const gaClient = new GaClient({
  id: "G-HB0VNVBEDQ",
  secret: process.env.GA_SECRET as string,
});
