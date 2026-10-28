// Upstream: core/collection_model_view_options_test.go
//
// Each case runs on a fresh copy of the vendored fixture (openTestApp), as
// upstream's tests.NewTestApp does, and validates with validateCollection.
// Cases that need the view field generation and the view query check
// (M1.7) are pending (caseTest).

import { describe } from "bun:test";

import { newViewCollection } from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { validateCollection } from "@/collections/collection-validate";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import {
  type Pending,
  caseTest,
  expectValidationErrors,
  pendingView,
} from "@test/collections/validation";

interface Scenario {
  name: string;
  collection: (app: TestCollectionsApp) => ReturnType<typeof newViewCollection>;
  expectedErrors: string[];
  pending?: Pending;
}

const scenarios: Scenario[] = [
  {
    name: "view with empty query",
    collection: () => newViewCollection("new_auth"),
    expectedErrors: ["fields", "viewQuery"],
  },
  {
    name: "view with invalid query",
    collection: () => {
      const c = newViewCollection("new_auth");
      c.viewQuery = "invalid";
      return c;
    },
    expectedErrors: ["fields", "viewQuery"],
    pending: pendingView,
  },
  {
    name: "view with valid query but missing id",
    collection: () => {
      const c = newViewCollection("new_auth");
      c.viewQuery = "select 1";
      return c;
    },
    expectedErrors: ["fields", "viewQuery"],
    pending: pendingView,
  },
  {
    name: "view with valid query but empty sample id",
    collection: () => {
      const c = newViewCollection("new_auth");
      c.viewQuery = "select '' as id";
      return c;
    },
    expectedErrors: ["viewQuery"],
    pending: pendingView,
  },
  {
    name: "view with valid query but duplicated sample id",
    collection: () => {
      const c = newViewCollection("new_auth");
      c.viewQuery = "(select 'a' as id union all select 'a' as id union all select 'c' as id)";
      return c;
    },
    expectedErrors: ["viewQuery"],
    pending: pendingView,
  },
  {
    name: "view with valid query",
    collection: () => {
      const c = newViewCollection("new_auth");
      c.viewQuery = "select demo1.id, text as example from demo1";
      return c;
    },
    expectedErrors: [],
    pending: pendingView,
  },
  {
    name: "update view query ",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "view2");
      c.viewQuery = "select demo1.id, text as example from demo1";
      return c;
    },
    expectedErrors: [],
  },
];

describe("TestCollectionViewOptionsValidate", () => {
  for (const s of scenarios) {
    caseTest(s.name, s.pending, () => {
      const app = openTestApp();
      try {
        const collection = s.collection(app);

        const result = validateCollection(app, collection);

        expectValidationErrors(result, s.expectedErrors);
      } finally {
        app.cleanup();
      }
    });
  }
});
