// js-sdk v0.28.1 src/tools/refresh.ts
import Client from "@sdk/Client";
import { isTokenExpired } from "@sdk/tools/jwt";

// the reset function that registerAutoRefresh attaches to the client dynamically
type AutoRefreshClient = Client & { _resetAutoRefresh?: () => void };

// reset previous auto refresh registrations
export function resetAutoRefresh(client: Client) {
  (client as AutoRefreshClient)._resetAutoRefresh?.();
}

export function registerAutoRefresh(
  client: Client,
  threshold: number,
  refreshFunc: () => Promise<unknown>,
  reauthenticateFunc: () => Promise<unknown>,
) {
  resetAutoRefresh(client);

  const oldBeforeSend = client.beforeSend;
  const oldModel = client.authStore.record;

  // unset the auto refresh in case the auth store was cleared
  // OR a new model was authenticated
  const unsubStoreChange = client.authStore.onChange((newToken, model) => {
    if (
      !newToken ||
      model?.id != oldModel?.id ||
      ((model?.collectionId || oldModel?.collectionId) &&
        model?.collectionId != oldModel?.collectionId)
    ) {
      resetAutoRefresh(client);
    }
  });

  // initialize a reset function and attach it dynamically to the client
  (client as AutoRefreshClient)._resetAutoRefresh = function () {
    unsubStoreChange();
    client.beforeSend = oldBeforeSend;
    delete (client as AutoRefreshClient)._resetAutoRefresh;
  };

  client.beforeSend = async (url, sendOptions) => {
    const oldToken = client.authStore.token;

    if (sendOptions.query?.autoRefresh) {
      return oldBeforeSend ? oldBeforeSend(url, sendOptions) : { url, sendOptions };
    }

    let isValid = client.authStore.isValid;
    if (
      // is loosely valid
      isValid &&
      // but it is going to expire in the next "threshold" seconds
      isTokenExpired(client.authStore.token, threshold)
    ) {
      try {
        await refreshFunc();
      } catch {
        isValid = false;
      }
    }

    // still invalid -> reauthenticate
    if (!isValid) {
      await reauthenticateFunc();
    }

    // the request wasn't sent with a custom token
    const headers = sendOptions.headers || {};
    for (let key in headers) {
      if (
        key.toLowerCase() == "authorization" &&
        // the request wasn't sent with a custom token
        oldToken == headers[key] &&
        client.authStore.token
      ) {
        // set the latest store token
        headers[key] = client.authStore.token;
        break;
      }
    }
    sendOptions.headers = headers;

    return oldBeforeSend ? oldBeforeSend(url, sendOptions) : { url, sendOptions };
  };
}
