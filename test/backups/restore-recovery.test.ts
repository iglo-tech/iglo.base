// Upstream: none. The roll back of an interrupted restore (src/backups/restore-phase.ts)
// on directories built by hand: the states a kill between two renames leaves,
// and the states a kill during the roll back itself leaves. What is on the disk
// afterwards is the observable result: the old data, whole, or a refusal that
// names where it is; never an empty or a mixed pb_data.

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  recoverInterruptedRestore,
  removeRestoreTemp,
  rollbackRestore,
} from "@/backups/restore-phase";
import { moveDirContent } from "@/tools/osutils/dir";

import { tempDir } from "@test/support/executable";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const oldFiles: Record<string, string> = {
  "data.db": "old-data",
  "auxiliary.db": "old-aux",
  "storage/a/file": "old-file",
};
const newFiles: Record<string, string> = {
  "data.db": "new-data",
  "auxiliary.db": "new-aux",
  "storage/b/file": "new-file",
};

function put(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function read(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walkDir = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (rel === "" && [".pb_temp_to_delete", "backups"].includes(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        walkDir(path);
      } else {
        out[path] = readFileSync(join(dir, path), "utf8");
      }
    }
  };
  walkDir("");
  return out;
}

// the top-level entries are what a restore moves
function top(files: Record<string, string>): string[] {
  return [...new Set(Object.keys(files).map((p) => p.split("/")[0] as string))].toSorted();
}

interface Layout {
  // the entries of the old data that moved aside (of "data.db", "auxiliary.db", "storage")
  aside: number;
  // the entries of the new data that moved in
  moved: number;
  phase: string | null;
  // an empty old dir, as a roll back leaves it
  oldDirEmpty?: boolean;
}

function build(layout: Layout): { dataDir: string; temp: string; oldDir: string } {
  const root = tempDir();
  roots.push(root);
  const dataDir = join(root, "pb_data");
  const temp = join(dataDir, ".pb_temp_to_delete");
  const oldDir = join(temp, "old_pb_data_s1");
  const extracted = join(temp, "pb_restore_s1");
  put(dataDir, oldFiles);
  put(extracted, newFiles);
  mkdirSync(oldDir, { recursive: true });
  for (const name of top(oldFiles).slice(0, layout.aside)) {
    renameSync(join(dataDir, name), join(oldDir, name));
  }
  for (const name of top(newFiles).slice(0, layout.moved)) {
    renameSync(join(extracted, name), join(dataDir, name));
  }
  if (layout.phase !== null) {
    writeFileSync(join(temp, `restore_phase.${layout.phase}`), "");
  }
  return { dataDir, temp, oldDir };
}

const names = top(oldFiles).length;

describe("recover an interrupted restore", () => {
  test("no restore: no temp dir, or no record and nothing aside", () => {
    const root = tempDir();
    roots.push(root);
    const dataDir = join(root, "pb_data");
    put(dataDir, oldFiles);
    recoverInterruptedRestore(dataDir);
    mkdirSync(join(dataDir, ".pb_temp_to_delete", "pb_restore_zipabc"), { recursive: true });
    recoverInterruptedRestore(dataDir);
    expect(read(dataDir)).toEqual(oldFiles);
  });

  // every phase value, with every number of moved entries it can have
  const states: Array<[string, Layout]> = [];
  for (let aside = 0; aside <= names; aside++) {
    states.push([`moving-old, ${aside} aside`, { aside, moved: 0, phase: "moving-old" }]);
  }
  for (let moved = 0; moved <= names; moved++) {
    states.push([`moving-new, ${moved} moved in`, { aside: names, moved, phase: "moving-new" }]);
  }
  for (const [label, layout] of states) {
    test(`${label}: the old data is back, also when recovery runs again`, () => {
      const { dataDir } = build(layout);
      recoverInterruptedRestore(dataDir);
      expect(read(dataDir)).toEqual(oldFiles);
      recoverInterruptedRestore(dataDir);
      expect(read(dataDir)).toEqual(oldFiles);
    });
  }

  test("swapped: the restored data stays and the old dir is not touched", () => {
    const { dataDir, oldDir } = build({ aside: names, moved: names, phase: "swapped" });
    recoverInterruptedRestore(dataDir);
    expect(read(dataDir)).toEqual(newFiles);
    expect(read(oldDir)).toEqual(oldFiles);
  });

  test("reverted: the old data stays", () => {
    const { dataDir } = build({ aside: 0, moved: 0, phase: "reverted" });
    recoverInterruptedRestore(dataDir);
    expect(read(dataDir)).toEqual(oldFiles);
  });

  test("storage/ in both the old and the new data, recovery run three times", () => {
    const { dataDir } = build({ aside: names, moved: names, phase: "moving-new" });
    expect(existsSync(join(dataDir, "storage"))).toBe(true);
    for (let i = 0; i < 3; i++) {
      recoverInterruptedRestore(dataDir);
      expect(read(dataDir)).toEqual(oldFiles);
    }
  });

  // a roll back killed after each of its renames: the dirs it leaves, resumed
  test("a roll back killed between its own moves resumes from every point", () => {
    // the moving-new roll back has: names entries out of pb_data, then names entries back
    for (let outCount = 0; outCount <= names; outCount++) {
      const { dataDir, temp } = build({ aside: names, moved: names, phase: "moving-new" });
      const extracted = join(temp, "pb_restore_s1");
      for (const name of top(newFiles).slice(0, outCount)) {
        renameSync(join(dataDir, name), join(extracted, name));
      }
      recoverInterruptedRestore(dataDir);
      expect(read(dataDir)).toEqual(oldFiles);
    }
    for (let back = 0; back <= names; back++) {
      // the first step is done and recorded, then `back` entries moved back
      const { dataDir, temp, oldDir } = build({ aside: names, moved: 0, phase: "moving-old" });
      for (const name of top(oldFiles).slice(0, back)) {
        renameSync(join(oldDir, name), join(dataDir, name));
      }
      recoverInterruptedRestore(dataDir);
      expect(read(dataDir)).toEqual(oldFiles);
      expect(existsSync(join(temp, "restore_phase.reverted"))).toBe(true);
    }
  });

  test("a start that fails after the roll back finds the same state again", () => {
    const { dataDir, temp } = build({ aside: names, moved: 1, phase: "moving-new" });
    recoverInterruptedRestore(dataDir);
    // a bootstrap that dies before it clears the temp dir, then starts again
    recoverInterruptedRestore(dataDir);
    expect(read(dataDir)).toEqual(oldFiles);
    expect(existsSync(join(temp, "restore_phase.reverted"))).toBe(true);
    // and the new data that went back is not in pb_data
    expect(existsSync(join(temp, "pb_restore_s1", "data.db"))).toBe(true);
  });

  test("a roll back of the revert path: swapped, then the record moves to moving-new", () => {
    const { dataDir, temp } = build({ aside: names, moved: names, phase: "swapped" });
    renameSync(join(temp, "restore_phase.swapped"), join(temp, "restore_phase.moving-new"));
    rollbackRestore(dataDir, temp);
    expect(read(dataDir)).toEqual(oldFiles);
  });

  describe("an unreadable record", () => {
    const records: Array<[string, (temp: string) => void]> = [
      ["an empty restore_phase file", (t) => writeFileSync(join(t, "restore_phase"), "")],
      ["a garbage restore_phase file", (t) => writeFileSync(join(t, "restore_phase"), "mo\0")],
      [
        "a restore_phase file of an old value",
        (t) => writeFileSync(join(t, "restore_phase"), "moving-new"),
      ],
      ["an unknown marker", (t) => writeFileSync(join(t, "restore_phase.wat"), "")],
      [
        "two markers",
        (t) => {
          writeFileSync(join(t, "restore_phase.moving-old"), "");
          writeFileSync(join(t, "restore_phase.moving-new"), "");
        },
      ],
      ["a missing record", () => undefined],
    ];
    for (const [label, make] of records) {
      test(`${label} with the old data aside: refuses to start and keeps everything`, () => {
        const { dataDir, temp, oldDir } = build({ aside: names, moved: 1, phase: null });
        make(temp);
        const before = { pb: read(dataDir), old: read(oldDir) };
        expect(() => recoverInterruptedRestore(dataDir)).toThrow(oldDir);
        expect({ pb: read(dataDir), old: read(oldDir) }).toEqual(before);
      });

      test(`${label} without anything aside: starts as no restore`, () => {
        const root = tempDir();
        roots.push(root);
        const dataDir = join(root, "pb_data");
        const temp = join(dataDir, ".pb_temp_to_delete");
        put(dataDir, oldFiles);
        mkdirSync(join(temp, "old_pb_data_s1"), { recursive: true });
        mkdirSync(join(temp, "pb_restore_s1"), { recursive: true });
        make(temp);
        recoverInterruptedRestore(dataDir);
        expect(read(dataDir)).toEqual(oldFiles);
      });
    }
  });

  test("moving-new without the old dir refuses to start", () => {
    const { dataDir, temp, oldDir } = build({ aside: names, moved: 1, phase: "moving-new" });
    const moved = join(temp, "moved_away");
    moveDirContent(oldDir, moved);
    rmSync(oldDir, { recursive: true });
    expect(() => recoverInterruptedRestore(dataDir)).toThrow("old data directory is missing");
  });
});

describe("clear the restore temp dir", () => {
  for (const phase of ["swapped", "reverted"]) {
    test(`${phase}: the old dir goes, the record last`, () => {
      const { temp, oldDir } = build({ aside: names, moved: names, phase });
      expect(removeRestoreTemp(temp)).toBe(true);
      expect(existsSync(oldDir)).toBe(false);
      expect(readdirSync(temp).filter((n) => n.startsWith("restore_phase"))).toEqual([]);
    });
  }
  for (const phase of ["moving-old", "moving-new", null]) {
    test(`${String(phase)}: an old dir with content is kept`, () => {
      const { temp, oldDir } = build({ aside: names, moved: 0, phase });
      expect(removeRestoreTemp(temp)).toBe(false);
      expect(read(oldDir)).toEqual(oldFiles);
    });
  }
});
