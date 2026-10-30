// The AfterTestFunc checks of apis/batch_test.go, through the records API.

import { type AfterContext } from "@test/scenarios/scenario";
import { superuserGet } from "@test/scenarios/record-checks";

type After = (ctx: AfterContext) => Promise<void>;

async function list(ctx: AfterContext, collection: string, filter: string): Promise<unknown[]> {
  const path = `/api/collections/${collection}/records?perPage=500&filter=${encodeURIComponent(filter)}`;
  const { status, json } = await superuserGet(ctx.url, path);
  if (status !== 200) {
    throw new Error(`list ${collection}: status ${status}`);
  }
  return (json as { items: unknown[] }).items;
}

export const after = {
  // records of the collection whose title contains text (`title~"text"`)
  titleCount(collection: string, text: string, n: number): After {
    return async (ctx) => {
      const items = await list(ctx, collection, `title~"${text}"`);
      if (items.length !== n) {
        throw new Error(`expected ${n} ${text} records, got ${items.length}`);
      }
    };
  },
  // the file count of the one record the filter finds
  filesCount(collection: string, filter: string, n: number): After {
    return async (ctx) => {
      const [record] = (await list(ctx, collection, filter)) as { files: string[] }[];
      if (record?.files.length !== n) {
        throw new Error(`expected ${n} files for ${filter}, got ${record?.files.length}`);
      }
    };
  },
  superuserMissing(email: string): After {
    return async (ctx) => {
      if ((await list(ctx, "_superusers", `email="${email}"`)).length !== 0) {
        throw new Error(`expected superuser ${email} to not be created`);
      }
    };
  },
};
