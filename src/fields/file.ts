// Upstream: core/field_file.go
//
// Intercept stores the new uploads before the record row is written
// (processFilesToUpload) and removes them when the write fails
// (afterRecordExecuteFailure, or deleteNewlyUploadedFiles when a commit
// outside a transaction fails); after a successful save it deletes the
// files the save removed from the value (rememberFilesToDelete,
// processFilesToDelete), with their thumbs. The storage
// (src/tools/filesystem) is synchronous, so Intercept stays synchronous
// inside a write transaction (D8, M1.8c). Errors upstream only logs go to
// the app logger.
//
// Values: a record value is a file name (string), a File
// (src/tools/filesystem/file.ts, a new upload) or an array of both. A JS
// array is Go's []any (each element is normalized on its own); Go's typed
// []string and []*filesystem.File give the same result for the values
// callers store.
//
// Not ported: the deprecation log line of the ":uploaded" getter (the
// fields have no logger, and upstream writes it with the standard log
// package, outside its app logger).

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  InterceptorActionCreateExecute,
  InterceptorActionUpdateExecute,
  internalCustomFieldKeyPrefix,
  marshalStruct,
  maxSafeJSONInt,
  type DriverValuer,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type GetterFinder,
  type GetterFunc,
  InterceptorActionAfterCreate,
  InterceptorActionAfterCreateError,
  InterceptorActionAfterUpdate,
  InterceptorActionAfterUpdateError,
  type InterceptorApp,
  type InterceptorRecord,
  type MaxBodySizeCalculator,
  type MultiValuer,
  type RecordInterceptor,
  type SetterFinder,
  type SetterFunc,
} from "@/fields/field";
import { joinErrors, wrapError } from "@/collections/view";
import { isNotFound } from "@/tools/filesystem/blob/bucket";
import { File } from "@/tools/filesystem/file";
import { type System, ThumbSizeRegex } from "@/tools/filesystem/filesystem";
import { toUniqueStringSlice } from "@/tools/list/list";
import { mustCompile } from "@/tools/regexp/regexp";
import {
  boolType,
  bytesToText,
  goInt,
  int64Type,
  intType,
  sliceOf,
  stringType,
  textToBytes,
  unmarshalStruct,
  type GoInt,
} from "@/tools/types/go-json";
import type { JSONArray } from "@/tools/types/json-array";
import { Each } from "@/validation/each";
import { NewError } from "@/validation/error";
import { Length } from "@/validation/length";
import { Match } from "@/validation/match";
import { Max, Min } from "@/validation/minmax";
import { NotIn } from "@/validation/not-in";
import { ErrRequired } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";
import { UploadedFileMimeType, UploadedFileSize } from "@/validators/file";

export const FieldTypeFile = "file";

// DefaultFileFieldMaxSize: 5 MiB
export const DefaultFileFieldMaxSize = 5 * 2 ** 20;

const looseFilenameRegex = mustCompile(String.raw`^[^\./\\][^/\\]+$`);

// the record keys of the files to delete after a save and of the files
// uploaded by it (used by Intercept)
export const deletedFilesPrefix = internalCustomFieldKeyPrefix + "_deletedFilesPrefix_";
export const uploadedFilesPrefix = internalCustomFieldKeyPrefix + "_uploadedFilesPrefix_";

// FileField defines "file" type field for managing record file(s).
//
// Only the file name is stored as part of the record value. New files (aka.
// files to upload) are expected to be of File.
//
// If MaxSelect is not set or <= 1, then the field value is expected to be a
// single record id.
//
// If MaxSelect is > 1, then the field value is expected to be a slice of
// record ids.
//
// The respective zero record field value is either empty string (single)
// or empty string slice (multiple).
//
// ---
//
// The following additional setter keys are available:
//
//   - "fieldName+" - append one or more files to the existing record one.
//     For example:
//
//     // ["old1.txt", "old2.txt", "new1_ajkvass.txt", "new2_klhfnwd.txt"]
//     record.set("documents+", [new1, new2])
//
//   - "+fieldName" - prepend one or more files to the existing record one.
//     For example:
//
//     // ["new1_ajkvass.txt", "new2_klhfnwd.txt", "old1.txt", "old2.txt"]
//     record.set("+documents", [new1, new2])
//
//   - "fieldName-" - subtract/delete one or more files from the existing
//     record one. For example:
//
//     // ["old2.txt"]
//     record.set("documents-", "old1.txt")
export class FileField
  implements
    Field,
    MultiValuer,
    DriverValuer,
    GetterFinder,
    SetterFinder,
    MaxBodySizeCalculator,
    RecordInterceptor
{
  // Name (required) is the unique name of the field.
  name = "";

  // Id is the unique stable field identifier.
  //
  // It is automatically generated from the name when adding to a
  // collection FieldsList.
  id = "";

  // System prevents the renaming and removal of the field.
  system = false;

  // Hidden hides the field from the API response.
  hidden = false;

  // ---

  // Presentable hints the Dashboard UI to use the underlying field record
  // value in the relation preview label.
  presentable = false;

  // Help is an extra text explaining what the field is about. It is
  // usually shown in Dashboard UI under the field input.
  help = "";

  // MaxSize specifies the maximum size of a single uploaded file (in bytes
  // and up to 2^53-1).
  //
  // If zero, a default limit of 5MB is applied.
  maxSize: GoInt = 0;

  // MaxSelect specifies the max allowed files.
  //
  // For multiple files the value must be > 1, otherwise fallbacks to
  // single (default).
  maxSelect: GoInt = 0;

  // MimeTypes specifies an optional list of the allowed file mime types.
  //
  // Leave it empty to disable the validator.
  mimeTypes: string[] = [];

  // Thumbs specifies an optional list of the supported thumbs for image
  // based files.
  //
  // Each entry must be in one of the following formats:
  //
  //   - WxH  (eg. 100x300) - crop to WxH viewbox (from center)
  //   - WxHt (eg. 100x300t) - crop to WxH viewbox (from top)
  //   - WxHb (eg. 100x300b) - crop to WxH viewbox (from bottom)
  //   - WxHf (eg. 100x300f) - fit inside a WxH viewbox (without cropping)
  //   - 0xH  (eg. 0x300)    - resize to H height preserving the aspect ratio
  //   - Wx0  (eg. 100x0)    - resize to W width preserving the aspect ratio
  thumbs: string[] = [];

  // Protected will require the users to provide a special file token to
  // access the file.
  //
  // Note that by default all files are publicly accessible.
  //
  // For the majority of the cases this is fine because by default all file
  // names have random part appended to their name which need to be known
  // by the user before accessing the file.
  protected = false;

  // Required will require the field value to have at least one file.
  required = false;

  constructor(init: Partial<FileFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeFile;
  }

  // GetId implements [Field.GetId] interface method.
  getId(): string {
    return this.id;
  }

  // SetId implements [Field.SetId] interface method.
  setId(id: string): void {
    this.id = id;
  }

  // GetName implements [Field.GetName] interface method.
  getName(): string {
    return this.name;
  }

  // SetName implements [Field.SetName] interface method.
  setName(name: string): void {
    this.name = name;
  }

  // GetSystem implements [Field.GetSystem] interface method.
  getSystem(): boolean {
    return this.system;
  }

  // SetSystem implements [Field.SetSystem] interface method.
  setSystem(system: boolean): void {
    this.system = system;
  }

  // GetHidden implements [Field.GetHidden] interface method.
  getHidden(): boolean {
    return this.hidden;
  }

  // SetHidden implements [Field.SetHidden] interface method.
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  // IsMultiple implements MultiValuer interface and checks whether the
  // current field options support multiple values.
  isMultiple(): boolean {
    return this.maxSelect > 1;
  }

  // ColumnType implements [Field.ColumnType] interface method.
  columnType(_app: FieldApp): string {
    if (this.isMultiple()) {
      return "JSON DEFAULT '[]' NOT NULL";
    }

    return "TEXT DEFAULT '' NOT NULL";
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    return [this.normalizeValue(raw), null];
  }

  // DriverValue implements the [DriverValuer] interface. A multiple value
  // is a types.JSONArray (an array here); the db layer stores it with
  // JSONArray's Value (jsonArrayValue in src/tools/types/json-array.ts).
  driverValue(record: FieldRecord): [unknown, Error | null] {
    const files = this.toSliceValue(record.getRaw(this.name));

    if (this.isMultiple()) {
      const ja: JSONArray<string> = files.map((v) => this.getFileName(v));
      return [ja, null];
    }

    if (files.length === 0) {
      return ["", null];
    }

    return [this.getFileName(files[files.length - 1]), null];
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, _collection: FieldCollection): Error | null {
    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField("maxSelect", this.maxSelect, Min(0), Max(maxSafeJSONInt)),
      StructField("maxSize", this.maxSize, Min(0), Max(maxSafeJSONInt)),
      StructField(
        "thumbs",
        this.thumbs,
        Each(NotIn("0x0", "0x0t", "0x0b", "0x0f"), Match(ThumbSizeRegex)),
      ),
    );
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(app: FieldApp, record: FieldRecord): Error | null {
    const files = this.toSliceValue(record.getRaw(this.name));
    if (files.length === 0) {
      if (this.required) {
        return ErrRequired;
      }
      return null; // nothing to check
    }

    // validate existing and disallow new plain string filenames submission
    // (new files must be File)
    // ---
    const oldExistingStrings = this.toSliceValue(this.getLatestOldValue(app, record));
    const existingStrings: unknown[] = this.extractPlainStrings(files);
    const addedStrings = this.excludeFiles(existingStrings, oldExistingStrings);

    if (addedStrings.length > 0) {
      const invalidFiles = addedStrings.map((invalid) => {
        // the first 250 bytes (Go's invalidStr[:250])
        const b = textToBytes(invalid as string);
        return b.length > 250 ? bytesToText(b.subarray(0, 250)) : (invalid as string);
      });

      return NewError("validation_invalid_file", "Invalid new files: {{.invalidFiles}}.").setParams(
        { invalidFiles },
      );
    }

    const maxSelect = this.getMaxSelect();
    if (files.length > maxSelect) {
      return NewError(
        "validation_too_many_files",
        "The maximum allowed files is {{.maxSelect}}",
      ).setParams({ maxSelect });
    }

    // validate uploaded
    // ---
    const uploads = this.extractUploadableFiles(files);
    for (const upload of uploads) {
      // loosely check the filename just in case it was manually changed after the normalization
      let err = Length(1, 150).validate(upload.name);
      if (err !== null) {
        return err;
      }
      err = Match(looseFilenameRegex).validate(upload.name);
      if (err !== null) {
        return err;
      }

      // check size
      err = UploadedFileSize(this.getMaxSize())(upload);
      if (err !== null) {
        return err;
      }

      // check type
      if (this.mimeTypes.length > 0) {
        err = UploadedFileMimeType(this.mimeTypes)(upload);
        if (err !== null) {
          return err;
        }
      }
    }

    return null;
  }

  // maxSize() of upstream (a getter here: maxSize is the setting)
  private getMaxSize(): GoInt {
    if (this.maxSize <= 0) {
      return DefaultFileFieldMaxSize;
    }

    return this.maxSize;
  }

  // maxSelect() of upstream (a getter here: maxSelect is the setting)
  private getMaxSelect(): GoInt {
    if (this.maxSelect <= 1) {
      return 1;
    }

    return this.maxSelect;
  }

  // Intercept implements the [RecordInterceptor] interface.
  //
  // The uploads and deletes are synchronous (src/tools/filesystem), so
  // Intercept stays synchronous unless actionFunc is async.
  intercept(
    app: InterceptorApp,
    record: InterceptorRecord,
    actionName: string,
    actionFunc: () => void | Promise<void>,
  ): void | Promise<void> {
    switch (actionName) {
      case InterceptorActionCreateExecute:
      case InterceptorActionUpdateExecute: {
        const oldValue = this.getLatestOldValue(app, record);

        this.processFilesToUpload(app, record);

        const onSuccess = (): void => {
          this.rememberFilesToDelete(record, oldValue);

          this.afterRecordExecuteSuccess(record);
        };
        const onFailure = (err: unknown): never => {
          let cleanupErr: unknown = null;
          try {
            this.afterRecordExecuteFailure(app, record);
          } catch (e) {
            cleanupErr = e;
          }
          throw cleanupErr === null ? err : joinErrors([err, cleanupErr]);
        };

        let result: void | Promise<void>;
        try {
          result = actionFunc();
        } catch (err) {
          return onFailure(err);
        }
        if (result instanceof Promise) {
          return result.then(onSuccess, onFailure);
        }
        onSuccess();
        return;
      }
      case InterceptorActionAfterCreateError:
      case InterceptorActionAfterUpdateError: {
        // when in transaction we assume that the error was handled by afterRecordExecuteFailure
        if (app.isTransactional()) {
          return actionFunc();
        }

        try {
          this.deleteNewlyUploadedFiles(app, record);
        } catch (err) {
          app.logger.error("Failed to cleanup all new files after record commit failure", err);
        }

        record.setRaw(deletedFilesPrefix + this.name, null);

        if (record.isNew()) {
          // try to delete the record directory if there are no other files
          //
          // note: executed only on create failure to avoid accidentally
          // deleting a concurrently updating directory due to the
          // eventual consistent nature of some storage providers
          try {
            this.deleteEmptyRecordDir(app, record);
          } catch (err) {
            app.logger.error("Failed to delete empty dir after new record commit failure", err);
          }
        }

        return actionFunc();
      }
      case InterceptorActionAfterCreate:
      case InterceptorActionAfterUpdate: {
        record.setRaw(uploadedFilesPrefix + this.name, null);

        this.processFilesToDelete(app, record);

        return actionFunc();
      }
      default:
        return actionFunc();
    }
  }

  // CalculateMaxBodySize implements the [MaxBodySizeCalculator] interface.
  // The int64 product wraps around on overflow, as in Go.
  calculateMaxBodySize(): GoInt {
    return goInt(BigInt.asIntN(64, BigInt(this.getMaxSize()) * BigInt(this.getMaxSelect())));
  }

  // getLatestOldValue: the field value of the latest saved record (read
  // again from the database for a record that is not new), else the
  // record's original value. The record save chain (src/records) passes
  // ValidateValue the interceptor app and a Record, which can look the
  // record up; other callers get the original value.
  private getLatestOldValue(app: FieldApp, record: FieldRecord): unknown {
    if (!record.isNew() && isInterceptorApp(app) && isInterceptorRecord(record)) {
      try {
        const latestOriginal = app.findRecordById(record.collection(), record.lastSavedPK());
        return latestOriginal.getRaw(this.name);
      } catch {
        // fall back to the original value
      }
    }

    return record.original().getRaw(this.name);
  }

  private afterRecordExecuteSuccess(record: InterceptorRecord): void {
    const uploaded = filesOf(record.getRaw(uploadedFilesPrefix + this.name));

    // replace the uploaded file objects with their plain string names
    const newValue = this.toSliceValue(record.getRaw(this.name));
    for (const [i, v] of newValue.entries()) {
      if (v instanceof File) {
        uploaded.push(v);
        newValue[i] = v.name;
      }
    }
    this.setValue(record, newValue);

    record.setRaw(uploadedFilesPrefix + this.name, uploaded);
  }

  // Throws the delete error.
  private afterRecordExecuteFailure(app: InterceptorApp, record: InterceptorRecord): void {
    const uploaded = this.extractUploadableFiles(this.toSliceValue(record.getRaw(this.name)));

    const toDelete = uploaded.map((file) => file.name);

    // delete previously uploaded files
    const [failedToDelete, deleteErr] = this.deleteFilesByNamesList(
      app,
      record,
      toUniqueStringSlice(toDelete),
    );

    if (failedToDelete.length > 0) {
      app.logger.error(
        `Failed to cleanup the new uploaded file after record db write failure: ${failedToDelete.join(", ")}`,
        deleteErr,
      );
    }

    if (deleteErr !== null) {
      throw deleteErr;
    }
  }

  // Throws the filesystem or delete error.
  private deleteEmptyRecordDir(app: InterceptorApp, record: InterceptorRecord): void {
    const fsys = app.newFilesystem();
    try {
      const dir = record.baseFilesPath();

      if (!fsys.isEmptyDir(dir)) {
        return; // no-op
      }

      try {
        fsys.delete(dir);
      } catch (err) {
        if (!isNotFound(err)) {
          throw err;
        }
      }
    } finally {
      fsys.close();
    }
  }

  // Throws the delete error.
  private processFilesToDelete(app: InterceptorApp, record: InterceptorRecord): void {
    const markedForDelete = stringsOf(record.getRaw(deletedFilesPrefix + this.name));
    if (markedForDelete.length === 0) {
      return;
    }

    const old: unknown[] = markedForDelete;
    const nw: unknown[] = this.extractPlainStrings(this.toSliceValue(record.getRaw(this.name)));
    const diff = this.excludeFiles(old, nw);

    const toDelete = diff.map((del) => this.getFileName(del));

    const [failedToDelete, err] = this.deleteFilesByNamesList(
      app,
      record,
      toUniqueStringSlice(toDelete),
    );

    record.setRaw(
      deletedFilesPrefix + this.name,
      failedToDelete.length > 0 ? failedToDelete : null,
    );

    if (err !== null) {
      throw err;
    }
  }

  private rememberFilesToDelete(record: InterceptorRecord, oldValue: unknown): void {
    const old: unknown[] = this.extractPlainStrings(this.toSliceValue(oldValue));
    const nw: unknown[] = this.extractPlainStrings(this.toSliceValue(record.getRaw(this.name)));
    const diff = this.excludeFiles(old, nw);

    const toDelete = stringsOf(record.getRaw(deletedFilesPrefix + this.name));

    for (const del of diff) {
      toDelete.push(this.getFileName(del));
    }

    record.setRaw(deletedFilesPrefix + this.name, toDelete);
  }

  // Throws the upload error (after removing the files it uploaded).
  private processFilesToUpload(app: InterceptorApp, record: InterceptorRecord): void {
    const uploads = this.extractUploadableFiles(this.toSliceValue(record.getRaw(this.name)));
    if (uploads.length === 0) {
      return;
    }

    if (record.id === "") {
      throw new Error("uploading files requires the record to have a valid nonempty id");
    }

    const fsys = app.newFilesystem();
    const failed: unknown[] = []; // list of upload errors
    const succeeded: string[] = []; // list of uploaded file names
    try {
      for (const upload of uploads) {
        const path = record.baseFilesPath() + "/" + upload.name;
        try {
          fsys.uploadFile(upload, path);
          succeeded.push(upload.name);
        } catch (err) {
          failed.push(wrapError(JSON.stringify(upload.name), err));
          break; // for now stop on the first error since we currently don't allow partial uploads
        }
      }
    } finally {
      fsys.close();
    }

    if (failed.length > 0) {
      // cleanup - try to delete the successfully uploaded files (if any)
      const [, cleanupErr] = this.deleteFilesByNamesList(app, record, succeeded);
      if (cleanupErr !== null) {
        failed.push(cleanupErr);
      }

      throw wrapError("failed to upload all files", joinErrors(failed));
    }
  }

  // Throws the delete error.
  private deleteNewlyUploadedFiles(app: InterceptorApp, record: InterceptorRecord): void {
    const uploaded = filesOf(record.getRaw(uploadedFilesPrefix + this.name));
    if (uploaded.length === 0) {
      return;
    }

    const names = uploaded.map((file) => file.name);

    const [failed, err] = this.deleteFilesByNamesList(app, record, toUniqueStringSlice(names));
    if (err !== null) {
      throw wrapError(`failed to delete ${failed.join(", ")}`, err);
    }

    record.setRaw(uploadedFilesPrefix + this.name, null);
  }

  // deleteFilesByNamesList deletes a list of record files by their names.
  // Returns the failed/remaining files and the error.
  private deleteFilesByNamesList(
    app: InterceptorApp,
    record: InterceptorRecord,
    filenames: string[],
  ): [string[], Error | null] {
    if (filenames.length === 0) {
      return [[], null]; // nothing to delete
    }

    if (record.id === "") {
      return [filenames, new Error("the record doesn't have an id")];
    }

    let fsys: System;
    try {
      fsys = app.newFilesystem();
    } catch (err) {
      return [filenames, toError(err)];
    }

    filenames = [...filenames];
    const failures: unknown[] = [];

    try {
      for (let i = filenames.length - 1; i >= 0; i--) {
        const filename = filenames[i] as string;
        if (filename === "" || filename.includes("/") || filename.includes("\\")) {
          continue; // empty or not a plain filename
        }

        const path = record.baseFilesPath() + "/" + filename;

        let deleteErr: unknown = null;
        try {
          fsys.delete(path);
        } catch (err) {
          deleteErr = err;
        }
        if (deleteErr !== null && !isNotFound(deleteErr)) {
          // store the delete error
          failures.push(wrapError(`file ${i} (${JSON.stringify(filename)})`, deleteErr));
        } else {
          // remove the deleted file from the list
          filenames.splice(i, 1);

          // try to delete the related file thumbs (if any)
          const thumbsErr = fsys.deletePrefix(record.baseFilesPath() + "/thumbs_" + filename + "/");
          if (thumbsErr.length > 0) {
            app.logger.error("Failed to delete file thumbs", joinErrors(thumbsErr));
          }
        }
      }
    } finally {
      fsys.close();
    }

    if (failures.length > 0) {
      return [filenames, wrapError("failed to delete all files", joinErrors(failures))];
    }

    return [[], null];
  }

  // -------------------------------------------------------------------

  // FindGetter implements the [GetterFinder] interface.
  findGetter(key: string): GetterFunc | null {
    switch (key) {
      case this.name:
        return (record) => record.getRaw(this.name);
      case this.name + ":unsaved":
        return (record) => this.extractUploadableFiles(this.toSliceValue(record.getRaw(this.name)));
      case this.name + ":uploaded":
        // deprecated (replaced by ":unsaved")
        return (record) => this.extractUploadableFiles(this.toSliceValue(record.getRaw(this.name)));
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------

  // FindSetter implements the [SetterFinder] interface.
  findSetter(key: string): SetterFunc | null {
    switch (key) {
      case this.name:
        return (record, raw) => this.setValue(record, raw);
      case "+" + this.name:
        return (record, raw) => this.prependValue(record, raw);
      case this.name + "+":
        return (record, raw) => this.appendValue(record, raw);
      case this.name + "-":
        return (record, raw) => this.subtractValue(record, raw);
      default:
        return null;
    }
  }

  private setValue(record: FieldRecord, raw: unknown): void {
    const val = this.normalizeValue(raw);

    record.setRaw(this.name, val);
  }

  private prependValue(record: FieldRecord, toPrepend: unknown): void {
    let files = this.toSliceValue(record.getRaw(this.name));
    const prepends = this.toSliceValue(toPrepend);

    if (prepends.length > 0) {
      files = [...prepends, ...files];
    }

    this.setValue(record, files);
  }

  private appendValue(record: FieldRecord, toAppend: unknown): void {
    let files = this.toSliceValue(record.getRaw(this.name));
    const appends = this.toSliceValue(toAppend);

    if (appends.length > 0) {
      files = [...files, ...appends];
    }

    this.setValue(record, files);
  }

  private subtractValue(record: FieldRecord, toRemove: unknown): void {
    const files = this.excludeFiles(
      this.toSliceValue(record.getRaw(this.name)),
      this.toSliceValue(toRemove),
    );

    this.setValue(record, files);
  }

  private normalizeValue(raw: unknown): unknown {
    const files = this.toSliceValue(raw);

    if (this.isMultiple()) {
      return files;
    }

    if (files.length > 0) {
      return files[files.length - 1]; // the last selected
    }

    return "";
  }

  private toSliceValue(raw: unknown): unknown[] {
    let result: unknown[] = [];

    if (raw === null || raw === undefined) {
      // nothing to cast
    } else if (raw instanceof File) {
      result.push(raw);
    } else if (Array.isArray(raw)) {
      for (const v of raw) {
        const casted = this.toSliceValue(v);
        if (casted.length === 1) {
          result.push(casted[0]);
        }
      }
    } else {
      result = toUniqueStringSlice(raw);
    }

    return this.uniqueFiles(result);
  }

  private uniqueFiles(files: unknown[]): unknown[] {
    const found = new Set<string>();
    const result: unknown[] = [];

    for (const fv of files) {
      const name = this.getFileName(fv);
      if (!found.has(name)) {
        result.push(fv);
        found.add(name);
      }
    }

    return result;
  }

  private extractPlainStrings(files: unknown[]): string[] {
    const result: string[] = [];

    for (const raw of files) {
      if (typeof raw === "string") {
        result.push(raw);
      }
    }

    return result;
  }

  private extractUploadableFiles(files: unknown[]): File[] {
    const result: File[] = [];

    for (const raw of files) {
      if (raw instanceof File) {
        result.push(raw);
      }
    }

    return result;
  }

  private excludeFiles(base: unknown[], toExclude: unknown[]): unknown[] {
    const result: unknown[] = [];

    for (const fv of base) {
      const name = this.getFileName(fv);
      if (toExclude.some((exclude) => this.getFileName(exclude) === name)) {
        continue; // skip
      }

      result.push(fv);
    }

    return result;
  }

  private getFileName(file: unknown): string {
    if (typeof file === "string") {
      return file;
    }
    if (file instanceof File) {
      return file.name;
    }
    return "";
  }

  // json.Marshal: the Go struct field order
  marshalJSON(): string {
    return marshalStruct([
      ["name", this.name],
      ["id", this.id],
      ["system", this.system],
      ["hidden", this.hidden],
      ["presentable", this.presentable],
      ["help", this.help],
      ["maxSize", this.maxSize],
      ["maxSelect", this.maxSelect],
      ["mimeTypes", this.mimeTypes],
      ["thumbs", this.thumbs],
      ["protected", this.protected],
      ["required", this.required],
    ]);
  }

  // json.Unmarshal
  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalStruct(
      data,
      {
        name: (v) => (this.name = v as string),
        id: (v) => (this.id = v as string),
        system: (v) => (this.system = v as boolean),
        hidden: (v) => (this.hidden = v as boolean),
        presentable: (v) => (this.presentable = v as boolean),
        help: (v) => (this.help = v as string),
        maxSize: (v) => (this.maxSize = v as GoInt),
        maxSelect: (v) => (this.maxSelect = v as GoInt),
        mimeTypes: (v) => (this.mimeTypes = (v as string[] | undefined) ?? []),
        thumbs: (v) => (this.thumbs = (v as string[] | undefined) ?? []),
        protected: (v) => (this.protected = v as boolean),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        maxSize: int64Type,
        maxSelect: intType,
        mimeTypes: sliceOf(stringType),
        thumbs: sliceOf(stringType),
        protected: boolType,
        required: boolType,
      },
      () => Object.assign(this, new FileField()),
    );
  }
}

export type FileFieldSettings = Pick<
  FileField,
  | "name"
  | "id"
  | "system"
  | "hidden"
  | "presentable"
  | "help"
  | "maxSize"
  | "maxSelect"
  | "mimeTypes"
  | "thumbs"
  | "protected"
  | "required"
>;

// the files of a record value ([]*filesystem.File type assertion)
function filesOf(raw: unknown): File[] {
  return Array.isArray(raw) ? raw.filter((v): v is File => v instanceof File) : [];
}

// the strings of a record value ([]string type assertion)
function stringsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isInterceptorApp(app: FieldApp): app is InterceptorApp {
  return typeof (app as Partial<InterceptorApp>).findRecordById === "function";
}

function isInterceptorRecord(record: FieldRecord): record is InterceptorRecord {
  return typeof (record as Partial<InterceptorRecord>).collection === "function";
}
