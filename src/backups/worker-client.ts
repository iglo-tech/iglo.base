// Upstream: none. The main thread's side of the backup worker
// (backup-worker.ts): one worker per running backup or restore, stopped when
// it ends, so an idle server holds no memory for it. Each call answers
// once its work is done.

export type BackupRequest = { id: number } & (
  | { op: "vacuum"; src: string; dest: string }
  | { op: "checkpoint"; path: string }
  | { op: "zipOpen"; path: string }
  | { op: "zipAdd"; localPath: string; zipPath: string }
  | { op: "zipAddOpen"; fd: number; zipPath: string }
  | { op: "closeFd"; fd: number }
  | { op: "zipClose" }
  | { op: "zipAbort" }
  | { op: "extract"; src: string; dest: string }
);

export type BackupResponse =
  | { id: number; ok: true; value: boolean | undefined }
  | { id: number; ok: false; message: string; code: string | null };

// distributes Omit over the union of requests
type Call<T> = T extends unknown ? Omit<T, "id"> : never;

// backup-worker.ts, beside this file, or in the compiled executable
function workerURL(): string {
  if (import.meta.path.startsWith("/$bunfs/")) {
    return "./backups/backup-worker.ts";
  }
  return new URL("backup-worker.ts", import.meta.url).href;
}

interface Pending {
  resolve: (value: boolean | undefined) => void;
  reject: (err: Error) => void;
}

export class BackupWorker {
  readonly #worker = new Worker(workerURL());
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  // set once the worker errored or was stopped: it answers no call any more
  #dead: Error | null = null;

  constructor() {
    this.#worker.addEventListener("message", (event: MessageEvent<BackupResponse>) => {
      const res = event.data;
      const pending = this.#pending.get(res.id);
      this.#pending.delete(res.id);
      if (res.ok) {
        pending?.resolve(res.value);
      } else {
        pending?.reject(Object.assign(new Error(res.message), { code: res.code ?? undefined }));
      }
    });
    this.#worker.addEventListener("error", (event: ErrorEvent) => {
      this.#dead ??= new Error(event.message);
      this.#failAll(this.#dead);
      this.#worker.terminate();
    });
  }

  call(request: Call<BackupRequest>): Promise<boolean | undefined> {
    if (this.#dead) {
      return Promise.reject(this.#dead);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // a Worker's postMessage has no target origin (that is window.postMessage)
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      this.#worker.postMessage({ ...request, id });
    });
  }

  close(): void {
    this.#dead ??= new Error("the backup worker was stopped");
    this.#failAll(this.#dead);
    this.#worker.terminate();
  }

  #failAll(err: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(err);
    }
    this.#pending.clear();
  }
}
