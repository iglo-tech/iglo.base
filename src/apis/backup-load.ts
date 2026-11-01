// Upstream: the "Failed to load backups filesystem." error of apis/backup.go

import { ErrBackupsS3NotSupported } from "@/app/filesystem";

// upstream's text, which says why when the reason is S3 (until M5.4)
export function loadFailure(err: unknown): string {
  const message = "Failed to load backups filesystem.";
  return err === ErrBackupsS3NotSupported
    ? `${message} Raw error: \n${ErrBackupsS3NotSupported.message}`
    : message;
}
