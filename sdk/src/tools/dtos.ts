// js-sdk v0.28.1 src/tools/dtos.ts
import type { Loose, LooseObject } from "@sdk/tools/loose";
export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: Array<T>;
}

export interface BaseModel {
  [key: string]: Loose;

  id: string;
}

export interface LogModel extends BaseModel {
  level: string;
  message: string;
  created: string;
  updated: string;
  data: LooseObject;
}

export interface RecordModel extends BaseModel {
  collectionId: string;
  collectionName: string;
  expand?: LooseObject;
}

// -------------------------------------------------------------------
// Collection types
// -------------------------------------------------------------------

export interface CollectionField {
  [key: string]: Loose;

  id: string;
  name: string;
  type: string;
  system: boolean;
  hidden: boolean;
  presentable: boolean;
}

export interface TokenConfig {
  duration: number;
  secret?: string;
}

export interface AuthAlertConfig {
  enabled: boolean;
  emailTemplate: EmailTemplate;
}

export interface OTPConfig {
  enabled: boolean;
  duration: number;
  length: number;
  emailTemplate: EmailTemplate;
}

export interface MFAConfig {
  enabled: boolean;
  duration: number;
  rule: string;
}

export interface PasswordAuthConfig {
  enabled: boolean;
  identityFields: Array<string>;
}

export interface OAuth2Provider {
  pkce?: boolean;
  clientId: string;
  name: string;
  clientSecret: string;
  authURL: string;
  tokenURL: string;
  userInfoURL: string;
  displayName: string;
  logo: string;
  extra?: LooseObject;
}

export interface ConfigurableOAuth2Provider {
  name: string;
  displayName: string;
  logo: string;
}

export interface OAuth2Config {
  enabled: boolean;
  mappedFields: { [key: string]: string };
  providers: Array<OAuth2Provider>;
}

export interface EmailTemplate {
  subject: string;
  body: string;
}

interface collection extends BaseModel {
  name: string;
  fields: Array<CollectionField>;
  indexes: Array<string>;
  system: boolean;
  listRule?: string;
  viewRule?: string;
  createRule?: string;
  updateRule?: string;
  deleteRule?: string;
}

export interface BaseCollectionModel extends collection {
  type: "base";
}

export interface ViewCollectionModel extends collection {
  type: "view";
  viewQuery: string;
}

export interface AuthCollectionModel extends collection {
  type: "auth";
  authRule?: string;
  manageRule?: string;
  authAlert: AuthAlertConfig;
  oauth2: OAuth2Config;
  passwordAuth: PasswordAuthConfig;
  mfa: MFAConfig;
  otp: OTPConfig;

  authToken: TokenConfig;
  passwordResetToken: TokenConfig;
  emailChangeToken: TokenConfig;
  verificationToken: TokenConfig;
  fileToken: TokenConfig;

  verificationTemplate: EmailTemplate;
  resetPasswordTemplate: EmailTemplate;
  confirmEmailChangeTemplate: EmailTemplate;
}

export type CollectionModel = BaseCollectionModel | ViewCollectionModel | AuthCollectionModel;
