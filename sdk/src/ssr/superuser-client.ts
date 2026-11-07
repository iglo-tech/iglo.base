// docs/design/13-ssr.md ("Clients", "Browser client and realtime")
import Client from "@sdk/Client";
import { BaseAuthStore } from "@sdk/stores/BaseAuthStore";
import { getTokenPayload } from "@sdk/tools/jwt";
import type { RecordModel } from "@sdk/tools/dtos";
import type { SendOptions } from "@sdk/tools/options";
import type { Loose } from "@sdk/tools/loose";
import type { CreateSuperuserClientOptions } from "@sdk/ssr/types";
import { registerAutoRefresh } from "@sdk/tools/refresh";
import { noStoreFetch } from "@sdk/ssr/no-store-fetch";

const DEFAULT_BROWSER_TOKEN_DURATION_SEC = 15 * 60; // 15 minutes (900 seconds)
const DEFAULT_AUTO_REFRESH_THRESHOLD_SEC = 300; // 5 minutes

export class SuperuserClient extends Client {
  private readonly _options: CreateSuperuserClientOptions;

  constructor(options: CreateSuperuserClientOptions) {
    const authStore = new BaseAuthStore();
    super(options.url, authStore, options.lang ?? "en-US");

    this._options = options;
    this.autoCancellation(false);
  }

  /**
   * Overriding send ensures cache: 'no-store' and custom fetch stick
   * even if application code assigns pb.beforeSend.
   */
  override async send<T = Loose>(path: string, options: SendOptions): Promise<T> {
    options.fetch = noStoreFetch(options.fetch ?? this._options.fetch);
    return super.send<T>(path, options);
  }

  async init(): Promise<this> {
    const threshold = this._options.autoRefreshThreshold ?? DEFAULT_AUTO_REFRESH_THRESHOLD_SEC;

    if (this._options.token) {
      const payload = getTokenPayload(this._options.token);
      const initialRecord: RecordModel = {
        id: payload.id || "",
        collectionId: payload.collectionId || "_superusers",
        collectionName: "_superusers",
      };
      this.authStore.save(this._options.token, initialRecord);

      if (threshold > 0) {
        registerAutoRefresh(
          this,
          threshold,
          () => this.collection("_superusers").authRefresh({ autoRefresh: true }),
          async () => {},
        );
      }
    } else if (this._options.email && this._options.password) {
      await this.collection("_superusers").authWithPassword(
        this._options.email,
        this._options.password,
        { autoRefreshThreshold: threshold },
      );
    }

    return this;
  }

  async impersonate(
    collectionOrRecord: string | RecordModel,
    recordIdOrDuration?: string | number,
    duration?: number,
  ): Promise<{ token: string; record: RecordModel }> {
    let collection: string;
    let recordId: string;
    let dur: number;

    if (typeof collectionOrRecord === "object" && collectionOrRecord !== null) {
      collection = collectionOrRecord.collectionName || collectionOrRecord.collectionId;
      recordId = collectionOrRecord.id;
      dur =
        typeof recordIdOrDuration === "number"
          ? recordIdOrDuration
          : (duration ?? DEFAULT_BROWSER_TOKEN_DURATION_SEC);
    } else {
      collection = collectionOrRecord;
      recordId = typeof recordIdOrDuration === "string" ? recordIdOrDuration : "";
      dur = duration ?? DEFAULT_BROWSER_TOKEN_DURATION_SEC;
    }

    const sendOpts: SendOptions = {
      method: "POST",
      body: { duration: dur },
      headers: {
        Authorization: this.authStore.token,
      },
    };

    if (this._options.fetch) {
      sendOpts.fetch = this._options.fetch;
    }

    const res = await this.send<{ token: string; record: RecordModel }>(
      `/api/collections/${encodeURIComponent(collection)}/impersonate/${encodeURIComponent(recordId)}`,
      sendOpts,
    );

    return {
      token: res.token,
      record: res.record,
    };
  }
}

export async function createSuperuserClient(
  options: CreateSuperuserClientOptions,
): Promise<SuperuserClient> {
  const client = new SuperuserClient(options);
  await client.init();
  return client;
}
