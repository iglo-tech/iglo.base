// Upstream: forms/record_upsert.go
//
// The record create/update form: loads the submitted data into the record
// (known collection fields only), validates the auth form fields
// (password, passwordConfirm, oldPassword, and the email and verified
// changes that need manage access) and saves the record with its
// validations (src/records/record-save.ts).
//
// Not ported: SetContext (there is no request context to cancel the save
// with) and the deprecated DrySubmit, which no handler calls.

import { FieldNameExpand, FieldNamePassword } from "@/fields/field";
import { PasswordFieldValue } from "@/fields/password";
import type { DataMap, Record } from "@/records/record-model";
import type { RecordsApp } from "@/records/record-query";
import { saveRecord, saveRecordSync } from "@/records/record-save";
import { toString } from "@/tools/types/cast";
import { NewError } from "@/validation/error";
import { Key, Map as ValidationMap } from "@/validation/map";
import { Required } from "@/validation/required";
import { By, Validate } from "@/validation/validation";
import { When } from "@/validation/when";
import { Equal } from "@/validators/equal";
import { ErrUnsupportedValueType } from "@/validators/validators";

const accessLevelDefault = 0;
const accessLevelManager = 1;
const accessLevelSuperuser = 2;

export class RecordUpsert {
  #app: RecordsApp;
  #record: Record;
  #accessLevel = accessLevelDefault;

  // extra password fields
  #disablePasswordValidations = false;
  #password = "";
  #passwordConfirm = "";
  #oldPassword = "";

  // NewRecordUpsert creates a new [RecordUpsert] form from the provided app and record
  // (for create you could pass a new empty record - newRecord(collection)).
  constructor(app: RecordsApp, record: Record) {
    this.#app = app;
    this.#record = record;
  }

  // SetApp replaces the current form app instance.
  //
  // This could be used for example if you want to change at later stage
  // before submission to change from regular -> transactional app instance.
  setApp(app: RecordsApp): void {
    this.#app = app;
  }

  // SetRecord replaces the current form record instance.
  setRecord(record: Record): void {
    this.#record = record;
  }

  // ResetAccess resets the form access level to the accessLevelDefault.
  resetAccess(): void {
    this.#accessLevel = accessLevelDefault;
  }

  // GrantManagerAccess updates the form access level to "manager" allowing
  // directly changing some system record fields (often used with auth collection records).
  grantManagerAccess(): void {
    this.#accessLevel = accessLevelManager;
  }

  // GrantSuperuserAccess updates the form access level to "superuser" allowing
  // directly changing all system record fields, including those marked as "Hidden".
  grantSuperuserAccess(): void {
    this.#accessLevel = accessLevelSuperuser;
  }

  // HasManageAccess reports whether the form has "manager" or "superuser" level access.
  hasManageAccess(): boolean {
    return this.#accessLevel === accessLevelManager || this.#accessLevel === accessLevelSuperuser;
  }

  // Load loads the provided data into the form and the related record.
  //
  // Go ranges over the data map in random order; the values are already
  // resolved (no modifier keys of the same field compete), so the order
  // here is the data's own.
  load(data: DataMap | null): void {
    const excludeFields = [FieldNameExpand];

    const isAuth = this.#record.collection().isAuth();

    // load the special auth form fields
    if (isAuth && data !== null) {
      if (Object.hasOwn(data, "password")) {
        this.#password = toString(data["password"]);
      }
      if (Object.hasOwn(data, "passwordConfirm")) {
        this.#passwordConfirm = toString(data["passwordConfirm"]);
      }
      if (Object.hasOwn(data, "oldPassword")) {
        this.#oldPassword = toString(data["oldPassword"]);
      }

      excludeFields.push("passwordConfirm", "oldPassword"); // skip non-schema password fields
    }

    for (const [k, v] of Object.entries(data ?? {})) {
      if (excludeFields.includes(k)) {
        continue;
      }

      // set only known collection fields
      const field = this.#record.setIfFieldExists(k, v);

      // restore original value if hidden field (with exception of the auth "password")
      //
      // note: this is an extra measure against loading hidden fields
      // but usually is not used by the default route handlers since
      // they filter additionally the data before calling Load
      if (
        this.#accessLevel !== accessLevelSuperuser &&
        field !== null &&
        field.getHidden() &&
        (!isAuth || field.getName() !== FieldNamePassword)
      ) {
        this.#record.setRaw(field.getName(), this.#record.original().getRaw(field.getName()));
      }
    }
  }

  private validateFormFields(): Error | null {
    const isAuth = this.#record.collection().isAuth();
    if (!isAuth) {
      return null;
    }

    this.syncPasswordFields();

    const isNew = this.#record.isNew();

    const original = this.#record.original();

    const validateData = {
      email: this.#record.email(),
      verified: this.#record.verified(),
      password: this.#password,
      passwordConfirm: this.#passwordConfirm,
      oldPassword: this.#oldPassword,
    };

    const disabled = this.#disablePasswordValidations;

    return Validate(
      validateData,
      ValidationMap(
        Key(
          "email",
          // don't allow direct email updates if the form doesn't have manage access permissions
          // (aka. allow only admin or authorized auth models to directly update the field)
          When(!isNew && !this.hasManageAccess(), By(Equal(original.email()))),
        ),
        Key(
          "verified",
          // don't allow changing verified if the form doesn't have manage access permissions
          // (aka. allow only admin or authorized auth models to directly change the field)
          When(!this.hasManageAccess(), By(Equal(original.verified()))),
        ),
        Key(
          "password",
          When(
            !disabled && (isNew || this.#passwordConfirm !== "" || this.#oldPassword !== ""),
            Required,
          ),
        ),
        Key(
          "passwordConfirm",
          When(!disabled && (isNew || this.#password !== "" || this.#oldPassword !== ""), Required),
          When(!disabled, By(Equal(this.#password))),
        ),
        Key(
          "oldPassword",
          // require old password only on update when:
          // - form.HasManageAccess() is not satisfied
          // - changing the existing password
          When(
            !disabled &&
              !isNew &&
              !this.hasManageAccess() &&
              (this.#password !== "" || this.#passwordConfirm !== ""),
            Required,
            By((value) => this.checkOldPassword(value)),
          ),
        ),
      ),
    );
  }

  private checkOldPassword(value: unknown): Error | null {
    if (typeof value !== "string") {
      return ErrUnsupportedValueType;
    }

    if (!this.#record.original().validatePassword(value)) {
      return NewError("validation_invalid_old_password", "Missing or invalid old password.");
    }

    return null;
  }

  // Submit validates the form specific validations and attempts to save the form record.
  async submit(): Promise<void> {
    const err = this.validateFormFields();
    if (err !== null) {
      throw err;
    }

    // run record validations and persist in db
    await saveRecord(this.#app, this.#record);
  }

  // Submit inside a transaction (the batch API, D28).
  submitSync(): void {
    const err = this.validateFormFields();
    if (err !== null) {
      throw err;
    }

    saveRecordSync(this.#app, this.#record);
  }

  // syncPasswordFields syncs the form's auth password fields with their
  // corresponding record field values.
  //
  // This could be useful in case the password fields were programmatically set
  // directly by modifying the related record model.
  private syncPasswordFields(): void {
    if (!this.#record.collection().isAuth()) {
      return; // not an auth collection
    }

    this.#disablePasswordValidations = false;

    const rawPassword = this.#record.getRaw(FieldNamePassword);
    if (rawPassword instanceof PasswordFieldValue) {
      if (
        // programmatically set custom plain password value
        (rawPassword.plain !== "" && rawPassword.plain !== this.#password) ||
        // random generated password for new record
        (rawPassword.plain === "" && rawPassword.hash !== "" && this.#record.isNew())
      ) {
        this.#disablePasswordValidations = true;
      }
    }
  }
}
