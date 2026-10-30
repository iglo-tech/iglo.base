// The data round-trip suite (docs/design/03-data-compatibility.md,
// Verification) against the reference PocketBase v0.41.0 binary. Not part of
// `bun test`: run `bun run test:reference`. The generated dataset is
// `bun run test:roundtrip:large` (large.ts).
//
// Each case runs the same three legs twice on its own copy of one starting
// pb_data: upstream, iglo.base, upstream, and a control with upstream alone.
// The results must be equal after the normalization of snapshot.ts.
//
//   (a) upstream's fixture, settings stored plain;
//   (b) a fresh install, settings encrypted on every leg;
//   (c) a fresh install where encryption is turned on between the legs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  freshStart,
  freshSuperuser,
  type Outcome,
  roundTrip,
  signedIn,
} from "@test/differential/roundtrip/run";
import {
  fixtureWrites,
  password,
  settingsScenario,
  writeScenario,
} from "@test/differential/roundtrip/scenario";
import { diffSnapshots, takeSnapshot, type Snapshot } from "@test/differential/roundtrip/snapshot";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { sharedSmtpSink } from "@test/support/smtp-sink";

const smtpPort = sharedSmtpSink().port;
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-roundtrip-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function keep(outcome: Outcome): Outcome {
  roots.push(outcome.control.root, outcome.subject.root);
  return outcome;
}

// the settings row of a snapshot
function settingsRow(snapshot: Snapshot): string {
  return (snapshot.sections.get("table _params") ?? []).find((row) =>
    row.includes("id='settings'"),
  ) as string;
}

// the differences between a control's pb_data and an altered copy of it
function alteredDiff(
  control: Outcome["control"],
  start: Outcome["start"],
  change: (dataDir: string) => void,
): string[] {
  const dataDir = join(tempRoot(), "pb_data");
  cpSync(control.dataDir, dataDir, { recursive: true });
  change(dataDir);
  const options = {
    start,
    startedAt: control.startedAt,
    generatedIds: control.state.generatedIds,
    ...(control.encryptionKey === undefined ? {} : { encryptionKey: control.encryptionKey }),
  };
  return diffSnapshots(takeSnapshot(control.dataDir, options), takeSnapshot(dataDir, options));
}

function sql(statement: string): (dataDir: string) => void {
  return (dataDir) => {
    const db = new Database(join(dataDir, "data.db"));
    try {
      db.run(statement);
    } finally {
      db.close();
    }
  };
}

// one of the stored `.attrs` files, or a stored file
function storedFile(dataDir: string, suffix: string): string {
  const glob = new Bun.Glob(`**/*${suffix}`);
  for (const path of glob.scanSync({ cwd: join(dataDir, "storage") })) {
    if (!path.includes("thumbs_")) {
      return join(dataDir, "storage", path);
    }
  }
  throw new Error(`no stored ${suffix} file`);
}

// (a) upstream's fixture
// -------------------------------------------------------------------

describe("upstream's fixture", () => {
  let outcome: Outcome;
  beforeAll(async () => {
    const dataDir = join(tempRoot(), "pb_data");
    copyDataDir(fixtureDir, dataDir);
    outcome = keep(
      await roundTrip(
        { dataDir, token: superuserToken },
        writeScenario({
          smtpPort,
          superuser: { email: "test@example.com", password },
          existing: fixtureWrites,
        }),
      ),
    );
  }, 300_000);

  test("upstream, iglo.base, upstream equals upstream alone", () => {
    expect(outcome.differences).toEqual([]);
  });

  test("the run covered what it should", () => {
    expect(outcome.subject.igloThumbs.size).toBeGreaterThan(0);
    expect(settingsRow(outcome.subjectSnapshot)).toContain("value=plain ");
  });
});

// (b) a fresh install, encrypted, and the self-test on its result
// -------------------------------------------------------------------

describe("a fresh install", () => {
  let outcome: Outcome;
  const altered = (change: (dataDir: string) => void): string[] =>
    alteredDiff(outcome.control, outcome.start, change);

  beforeAll(async () => {
    outcome = keep(
      await roundTrip(
        await freshStart(tempRoot()),
        signedIn(writeScenario({ smtpPort, superuser: freshSuperuser })),
        { encrypted: [true, true, true] },
      ),
    );
  }, 300_000);

  test("upstream, iglo.base, upstream equals upstream alone", () => {
    expect(outcome.differences).toEqual([]);
  });

  test("the run covered what it should", () => {
    expect(outcome.subject.igloThumbs.size).toBeGreaterThan(0);
    expect(settingsRow(outcome.subjectSnapshot)).toContain("value=encrypted ");
  });

  // the comparison itself: an altered copy of the control's pb_data must fail
  describe("the comparison catches", () => {
    test("nothing, on an unchanged copy", () => {
      expect(altered(() => undefined)).toEqual([]);
    });

    test("an extra index", () => {
      const out = altered(sql("CREATE INDEX idx_extra ON rta_all (t)"));
      expect(
        out.some((d) => d.startsWith("sqlite_schema: subject only") && d.includes("idx_extra")),
      ).toBe(true);
    });

    test("an extra table", () => {
      const out = altered(sql("CREATE TABLE _iglo (id TEXT)"));
      expect(out.some((d) => d.startsWith("sqlite_schema: subject only"))).toBe(true);
      expect(out).toContain("table _iglo: only in the subject");
    });

    test("an extra column", () => {
      const out = altered(sql("ALTER TABLE rta_all ADD COLUMN extra TEXT"));
      expect(out.some((d) => d.includes("extra"))).toBe(true);
    });

    test("an extra trigger", () => {
      const out = altered(
        sql("CREATE TRIGGER t_extra AFTER INSERT ON rta_all BEGIN SELECT 1; END"),
      );
      expect(out.some((d) => d.includes("t_extra"))).toBe(true);
    });

    test("an extra _params row", () => {
      const out = altered(
        sql(`INSERT INTO _params (id, value, created, updated) VALUES ('extra', 'x', '', '')`),
      );
      expect(out.some((d) => d.startsWith("table _params: subject only"))).toBe(true);
    });

    test("an extra _migrations row", () => {
      const out = altered(sql(`INSERT INTO _migrations (file, applied) VALUES ('extra.go', 1)`));
      expect(out.some((d) => d.startsWith("table _migrations: subject only"))).toBe(true);
    });

    test("a changed row", () => {
      const out = altered(sql(`UPDATE rta_all SET t = 'changed' WHERE t = 'updated'`));
      expect(out.some((d) => d.startsWith("table rta_all: subject only"))).toBe(true);
    });

    test("a changed integer's text in a json value", () => {
      const out = altered(
        sql(`UPDATE rta_all SET j = replace(j, '12345678901234567890', '12345678901234567000')`),
      );
      expect(out.some((d) => d.startsWith("table rta_all: subject only"))).toBe(true);
    });

    test("a changed storage class", () => {
      const out = altered(sql(`UPDATE rta_all SET n = CAST(n AS REAL) + 0.5 WHERE n = 1`));
      expect(out.some((d) => d.startsWith("table rta_all: subject only"))).toBe(true);
    });

    test("a rewritten password hash", () => {
      const out = altered(
        sql(
          `UPDATE rta_people SET password = '$2b$' || substr(password, 5) WHERE nick LIKE 'alice%'`,
        ),
      );
      expect(out.some((d) => d.startsWith("table rta_people: subject only"))).toBe(true);
    });

    test("a rewritten old timestamp", () => {
      const out = altered(
        sql(
          `UPDATE _collections SET created = '2021-01-01 00:00:00.000Z' WHERE name = '_superusers'`,
        ),
      );
      expect(out.some((d) => d.startsWith("table _collections: subject only"))).toBe(true);
    });

    test("a changed _migrations row", () => {
      const out = altered(sql(`UPDATE _migrations SET applied = applied + 1`));
      expect(out.some((d) => d.startsWith("table _migrations: subject only"))).toBe(true);
    });

    test("a changed .attrs", () => {
      const out = altered((dataDir) => {
        appendFileSync(storedFile(dataDir, ".attrs"), " ");
      });
      expect(out.some((d) => d.startsWith("storage: subject only") && d.includes(".attrs"))).toBe(
        true,
      );
    });

    test("changed file bytes", () => {
      const out = altered((dataDir) => {
        appendFileSync(storedFile(dataDir, ".txt"), "x");
      });
      expect(out.some((d) => d.startsWith("storage: subject only"))).toBe(true);
    });

    test("a stray file in storage", () => {
      const out = altered((dataDir) => {
        writeFileSync(`${storedFile(dataDir, ".txt")}.stray`, "x");
      });
      expect(out.some((d) => d.startsWith("storage: subject only") && d.includes(".stray"))).toBe(
        true,
      );
    });

    test("a stray file in pb_data", () => {
      const out = altered((dataDir) => {
        writeFileSync(join(dataDir, "extra.db"), "x");
      });
      expect(out).toContain("pb_data: subject only: extra.db");
    });

    test("but not a missing sqlite_stat4, the one known difference", () => {
      expect(altered(sql("DROP TABLE sqlite_stat4"))).toEqual([]);
    });
  });
});

// (c) encryption turned on between the legs
// -------------------------------------------------------------------

describe("encryption turned on after the first leg", () => {
  test("upstream, iglo.base, upstream equals upstream alone", async () => {
    const outcome = keep(
      await roundTrip(await freshStart(tempRoot()), signedIn(settingsScenario(smtpPort)), {
        encrypted: [false, true, true],
      }),
    );
    expect(outcome.differences).toEqual([]);
    expect(settingsRow(outcome.subjectSnapshot)).toContain("value=encrypted ");
  }, 120_000);
});
