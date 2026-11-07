// js-sdk v0.28.1 src/services/SettingsService.ts
import type { LooseObject } from "@sdk/tools/loose";
import { BaseService } from "@sdk/services/BaseService";
import { type CommonOptions } from "@sdk/tools/options";

interface appleClientSecret {
  secret: string;
}

export class SettingsService extends BaseService {
  /**
   * Fetch all available app settings.
   *
   * @throws {ClientResponseError}
   */
  async getAll(options?: CommonOptions): Promise<LooseObject> {
    options = Object.assign(
      {
        method: "GET",
      },
      options,
    );

    return this.client.send("/api/settings", options);
  }

  /**
   * Bulk updates app settings.
   *
   * @throws {ClientResponseError}
   */
  async update(bodyParams?: LooseObject | FormData, options?: CommonOptions): Promise<LooseObject> {
    options = Object.assign(
      {
        method: "PATCH",
        body: bodyParams,
      },
      options,
    );

    return this.client.send("/api/settings", options);
  }

  /**
   * Performs a S3 filesystem connection test.
   *
   * The currently supported `filesystem` are "storage" and "backups".
   *
   * @throws {ClientResponseError}
   */
  async testS3(filesystem: string = "storage", options?: CommonOptions): Promise<boolean> {
    options = Object.assign(
      {
        method: "POST",
        body: {
          filesystem: filesystem,
        },
      },
      options,
    );

    return this.client.send("/api/settings/test/s3", options).then(() => true);
  }

  /**
   * Sends a test email.
   *
   * The possible `emailTemplate` values are:
   * - verification
   * - password-reset
   * - email-change
   *
   * @throws {ClientResponseError}
   */
  async testEmail(
    collectionIdOrName: string,
    toEmail: string,
    emailTemplate: string,
    options?: CommonOptions,
  ): Promise<boolean> {
    options = Object.assign(
      {
        method: "POST",
        body: {
          email: toEmail,
          template: emailTemplate,
          collection: collectionIdOrName,
        },
      },
      options,
    );

    return this.client.send("/api/settings/test/email", options).then(() => true);
  }

  /**
   * Generates a new Apple OAuth2 client secret.
   *
   * @throws {ClientResponseError}
   */
  async generateAppleClientSecret(
    clientId: string,
    teamId: string,
    keyId: string,
    privateKey: string,
    duration: number,
    options?: CommonOptions,
  ): Promise<appleClientSecret> {
    options = Object.assign(
      {
        method: "POST",
        body: {
          clientId,
          teamId,
          keyId,
          privateKey,
          duration,
        },
      },
      options,
    );

    return this.client.send("/api/settings/apple/generate-client-secret", options);
  }
}
