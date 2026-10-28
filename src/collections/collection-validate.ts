// Upstream: core/collection_validate.go, with checkForVia from core/field.go
//
// validateCollection is onCollectionValidate: it loads the collection's
// stored state (when it is not new) and runs the collection validator.
// Upstream runs it from the OnCollectionValidate hook; there is no hook
// system (D5), so the save step (M1.7) calls it directly.
//
// checkRule's expression check (checkRuleExpr) builds the rule with the
// record field resolver (src/resolver/) and an empty RequestInfo.
//
// A view's fields are generated from its query (createViewFields) and the
// query is run (dryRunView) with view.ts.

import {
  type AuthOptionsValidator,
  validateAuthOptions,
} from "@/collections/collection-model-auth-options";
import {
  Collection,
  CollectionTypeAuth,
  CollectionTypeBase,
  CollectionTypeView,
  newCollection,
} from "@/collections/collection-model";
import {
  type ViewOptionsValidator,
  validateViewOptions,
} from "@/collections/collection-model-view-options";
import {
  type CollectionsApp,
  fieldApp,
  isCollectionNameUnique,
} from "@/collections/collection-query";
import { FieldsList } from "@/collections/fields-list";
import { RequestInfo } from "@/app/event-request";
import { createViewFields, dryRunView } from "@/collections/view";
import { equalFold, toLower } from "@/collections/go-strings";
import { modelQuery } from "@/db/db";
import { HashExp, newExp } from "@/db/dbx/expression";
import { hasTable } from "@/db/table";
import { BoolField } from "@/fields/bool";
import { EmailField } from "@/fields/email";
import {
  ErrMustBeSystem,
  ErrMustBeSystemAndHidden,
  FieldNameEmail,
  FieldNameEmailVisibility,
  FieldNameId,
  FieldNamePassword,
  FieldNameTokenKey,
  FieldNameVerified,
  goQuote,
} from "@/fields/field";
import { PasswordField } from "@/fields/password";
import { TextField } from "@/fields/text";
import { newRecordFieldResolver } from "@/resolver/record-field-resolver";
import { filterBuildExpr } from "@/search/filter";
import { findSingleColumnUniqueIndex, parseIndex } from "@/tools/dbutils/index";
import { existInSlice } from "@/tools/list/list";
import { mustCompile } from "@/tools/regexp/regexp";
import { bytesToText, textToBytes } from "@/tools/types/go-json";
import { Errors, NewError, type Error as ValidationError } from "@/validation/error";
import { In } from "@/validation/in";
import { Length } from "@/validation/length";
import { Match } from "@/validation/match";
import { Nil } from "@/validation/absent";
import { ErrRequired, Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";
import { When } from "@/validation/when";
import { Equal } from "@/validators/equal";
import { UniqueId } from "@/validators/db";
import { ErrUnsupportedValueType, JoinValidationErrors } from "@/validators/validators";

// core/db.go DefaultIdRegex
const defaultIdRegex = mustCompile(String.raw`^\w+$`);

const collectionNameRegex = mustCompile(String.raw`^\w+$`);

const reservedAuthKeys = ["passwordConfirm", "oldPassword"];

// onCollectionValidate: validates the collection against its stored state
// (none when it is new). Returns the validation errors (validation.Errors
// when a check fails), or an error when the stored state cannot be loaded.
export function validateCollection(app: CollectionsApp, collection: Collection): Error | null {
  let original: Collection | null = null;
  if (!collection.isNew()) {
    original = new Collection();
    try {
      modelQuery(app.databases, original).model(collection.lastSavedPK(), original);
    } catch (err) {
      return new Error(
        `failed to fetch old collection state: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  return newCollectionValidator(app, collection, original).run();
}

export function newCollectionValidator(
  app: CollectionsApp,
  newC: Collection,
  original: Collection | null,
): CollectionValidator {
  // load old/original collection
  return new CollectionValidator(app, newC, original ?? newCollection(newC.type, ""));
}

// collectionValidator; newC is Go's `new` (a reserved word here)
export class CollectionValidator implements AuthOptionsValidator, ViewOptionsValidator {
  constructor(
    readonly app: CollectionsApp,
    readonly newC: Collection,
    readonly original: Collection,
  ) {}

  run(): Error | null {
    if (this.original.isNew()) {
      this.newC.updateGeneratedIdIfExists(this.app);
    }

    // generate fields from the query (overwriting any explicit user defined fields)
    if (this.newC.isView()) {
      const [fields] = createViewFields(this.app, this.newC.viewQuery);
      this.newC.fields = fields;
    }

    // validate base fields
    const baseErr = ValidateStruct(
      Field(
        "id",
        this.newC.id,
        Required,
        When(
          this.original.isNew(),
          Length(1, 100),
          Match(defaultIdRegex),
          By(UniqueId(this.app.databases.concurrentDB(), this.newC.tableName())),
        ).else(By(Equal(this.original.id))),
      ),
      Field("system", this.newC.system, By(this.ensureNoSystemFlagChange)),
      Field(
        "type",
        this.newC.type,
        Required,
        In(CollectionTypeBase, CollectionTypeAuth, CollectionTypeView),
        By(this.ensureNoTypeChange),
      ),
      Field(
        "name",
        this.newC.name,
        Required,
        Length(1, 255),
        By(checkForVia),
        Match(collectionNameRegex),
        By(this.ensureNoSystemNameChange),
        By(this.checkUniqueName),
      ),
      Field(
        "fields",
        this.newC.fields,
        By(this.checkFieldDuplicates),
        By(this.checkMinFields),
        When(
          !this.newC.isView(),
          By(this.ensureNoSystemFieldsChange),
          By(this.ensureNoFieldsTypeChange),
        ),
        When(this.newC.isAuth(), By(this.checkReservedAuthKeys)),
        By(this.checkFieldValidators),
      ),
      Field(
        "listRule",
        this.newC.listRule,
        By(this.checkRule),
        By(this.ensureNoSystemRuleChange(this.original.listRule)),
      ),
      Field(
        "viewRule",
        this.newC.viewRule,
        By(this.checkRule),
        By(this.ensureNoSystemRuleChange(this.original.viewRule)),
      ),
      Field(
        "createRule",
        this.newC.createRule,
        When(this.newC.isView(), Nil),
        By(this.checkRule),
        By(this.ensureNoSystemRuleChange(this.original.createRule)),
      ),
      Field(
        "updateRule",
        this.newC.updateRule,
        When(this.newC.isView(), Nil),
        By(this.checkRule),
        By(this.ensureNoSystemRuleChange(this.original.updateRule)),
      ),
      Field(
        "deleteRule",
        this.newC.deleteRule,
        When(this.newC.isView(), Nil),
        By(this.checkRule),
        By(this.ensureNoSystemRuleChange(this.original.deleteRule)),
      ),
      Field("indexes", this.newC.indexes, By(this.checkIndexes)),
    );

    const optionsErr = this.validateOptions();

    return JoinValidationErrors(baseErr, optionsErr);
  }

  checkUniqueName = (value: unknown): ValidationError | null => {
    const v = typeof value === "string" ? value : "";

    // ensure unique collection name
    if (!isCollectionNameUnique(this.app, v, this.original.id)) {
      return NewError(
        "validation_collection_name_exists",
        "Collection name must be unique (case insensitive).",
      );
    }

    // ensure that the collection name doesn't collide with the id of any collection
    const dummyCollection = new Collection();
    let found = false;
    try {
      modelQuery(this.app.databases, dummyCollection).model(v, dummyCollection);
      found = true;
    } catch {
      found = false;
    }
    if (found) {
      return NewError(
        "validation_collection_name_id_duplicate",
        "The name must not match an existing collection id.",
      );
    }

    // ensure that there is no existing internal table with the provided name
    if (
      this.original.name !== v && // has changed
      isCollectionNameUnique(this.app, v) && // is not a collection (in case it was presaved)
      hasTable(this.app.databases, v)
    ) {
      return NewError(
        "validation_collection_name_invalid",
        "The name shouldn't match with an existing internal table.",
      );
    }

    return null;
  };

  ensureNoSystemNameChange = (value: unknown): ValidationError | null => {
    const v = typeof value === "string" ? value : "";

    if (!this.original.isNew() && this.original.system && v !== this.original.name) {
      return NewError(
        "validation_collection_system_name_change",
        "System collection name cannot be changed.",
      );
    }

    return null;
  };

  ensureNoSystemFlagChange = (value: unknown): ValidationError | null => {
    const v = typeof value === "boolean" ? value : false;

    if (!this.original.isNew() && v !== this.original.system) {
      return NewError(
        "validation_collection_system_flag_change",
        "System collection state cannot be changed.",
      );
    }

    return null;
  };

  ensureNoTypeChange = (value: unknown): ValidationError | null => {
    const v = typeof value === "string" ? value : "";

    if (!this.original.isNew() && v !== this.original.type) {
      return NewError("validation_collection_type_change", "Collection type cannot be changed.");
    }

    return null;
  };

  ensureNoFieldsTypeChange = (value: unknown): Error | null => {
    if (!(value instanceof FieldsList)) {
      return ErrUnsupportedValueType;
    }

    const errs = new Errors();

    for (const [i, field] of value.toArray().entries()) {
      const oldField = this.original.fields.getById(field.getId());

      if (oldField !== null && oldField.type() !== field.type()) {
        errs.errors[String(i)] = NewError(
          "validation_field_type_change",
          "Field type cannot be changed.",
        );
      }
    }
    if (errs.size > 0) {
      return errs;
    }

    return null;
  };

  checkFieldDuplicates = (value: unknown): Error | null => {
    if (!(value instanceof FieldsList)) {
      return ErrUnsupportedValueType;
    }

    const ids: string[] = [];
    const names: string[] = [];

    for (const [i, field] of value.toArray().entries()) {
      if (existInSlice(field.getId(), ids)) {
        return new Errors({
          [String(i)]: new Errors({
            id: NewError(
              "validation_duplicated_field_id",
              `Duplicated or invalid field id ${goQuote(field.getId())}`,
            ),
          }),
        });
      }

      // field names are used as db columns and should be case insensitive
      const nameLower = toLower(field.getName());

      if (existInSlice(nameLower, names)) {
        return new Errors({
          [String(i)]: new Errors({
            name: NewError(
              "validation_duplicated_field_name",
              "Duplicated or invalid field name {{.fieldName}}",
            ).setParams({
              fieldName: field.getName(),
            }),
          }),
        });
      }

      ids.push(field.getId());
      names.push(nameLower);
    }

    return null;
  };

  checkFieldValidators = (value: unknown): Error | null => {
    if (!(value instanceof FieldsList)) {
      return ErrUnsupportedValueType;
    }

    const errs = new Errors();
    const app = fieldApp(this.app);

    for (const [i, field] of value.toArray().entries()) {
      const err = field.validateSettings(app, this.newC);
      if (err !== null) {
        errs.errors[String(i)] = err;
      }
    }

    if (errs.size > 0) {
      return errs;
    }

    return null;
  };

  checkViewQuery = (value: unknown): ValidationError | null => {
    const v = typeof value === "string" ? value : "";
    if (v === "") {
      return null; // nothing to check
    }

    let err: unknown = null;
    try {
      dryRunView(this.app, v, 10);
    } catch (e) {
      err = e;
    }
    if (err !== null) {
      let rawErr = err instanceof Error ? err.message : String(err);
      const rawBytes = textToBytes(rawErr);
      if (rawBytes.length > 500) {
        // restrict just as an extra precaution
        rawErr = bytesToText(rawBytes.subarray(0, 500));
      }

      return NewError("validation_invalid_view_query", "Invalid query - " + rawErr);
    }

    return null;
  };

  checkReservedAuthKeys = (value: unknown): Error | null => {
    if (!(value instanceof FieldsList)) {
      return ErrUnsupportedValueType;
    }

    if (!this.newC.isAuth()) {
      return null; // not an auth collection
    }

    const errs = new Errors();
    for (const [i, field] of value.toArray().entries()) {
      if (existInSlice(field.getName(), reservedAuthKeys)) {
        errs.errors[String(i)] = new Errors({
          name: NewError(
            "validation_reserved_field_name",
            "The field name is reserved and cannot be used.",
          ),
        });
      }
    }
    if (errs.size > 0) {
      return errs;
    }

    return null;
  };

  checkMinFields = (value: unknown): Error | null => {
    if (!(value instanceof FieldsList)) {
      return ErrUnsupportedValueType;
    }

    if (value.length === 0) {
      return ErrRequired;
    }

    // all collections must have an "id" PK field
    const idField = value.getByName(FieldNameId);
    if (!(idField instanceof TextField) || !idField.primaryKey) {
      return NewError("validation_missing_primary_key", `Missing or invalid "id" PK field.`);
    }

    switch (this.newC.type) {
      case CollectionTypeAuth: {
        const passwordField = value.getByName(FieldNamePassword);
        if (!(passwordField instanceof PasswordField)) {
          return NewError(
            "validation_missing_password_field",
            `System "password" field is required.`,
          );
        }
        if (!passwordField.hidden || !passwordField.system) {
          return new Errors({ [FieldNamePassword]: ErrMustBeSystemAndHidden });
        }

        const tokenKeyField = value.getByName(FieldNameTokenKey);
        if (!(tokenKeyField instanceof TextField)) {
          return NewError(
            "validation_missing_tokenKey_field",
            `System "tokenKey" field is required.`,
          );
        }
        if (!tokenKeyField.hidden || !tokenKeyField.system) {
          return new Errors({ [FieldNameTokenKey]: ErrMustBeSystemAndHidden });
        }

        const emailField = value.getByName(FieldNameEmail);
        if (!(emailField instanceof EmailField)) {
          return NewError("validation_missing_email_field", `System "email" field is required.`);
        }
        if (!emailField.system) {
          return new Errors({ [FieldNameEmail]: ErrMustBeSystem });
        }

        const emailVisibilityField = value.getByName(FieldNameEmailVisibility);
        if (!(emailVisibilityField instanceof BoolField)) {
          return NewError(
            "validation_missing_emailVisibility_field",
            `System "emailVisibility" field is required.`,
          );
        }
        if (!emailVisibilityField.system) {
          return new Errors({ [FieldNameEmailVisibility]: ErrMustBeSystem });
        }

        const verifiedField = value.getByName(FieldNameVerified);
        if (!(verifiedField instanceof BoolField)) {
          return NewError(
            "validation_missing_verified_field",
            `System "verified" field is required.`,
          );
        }
        if (!verifiedField.system) {
          return new Errors({ [FieldNameVerified]: ErrMustBeSystem });
        }

        return null;
      }
    }

    return null;
  };

  ensureNoSystemFieldsChange = (value: unknown): Error | null => {
    if (!(value instanceof FieldsList)) {
      return ErrUnsupportedValueType;
    }

    if (this.original.isNew()) {
      return null; // not an update
    }

    for (const oldField of this.original.fields) {
      if (!oldField.getSystem()) {
        continue;
      }

      const newField = value.getById(oldField.getId());

      if (newField === null || oldField.getName() !== newField.getName()) {
        return NewError(
          "validation_system_field_change",
          "System fields cannot be deleted or renamed.",
        );
      }
    }

    return null;
  };

  checkFieldsForUniqueIndex = (value: unknown): Error | null => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      return ErrUnsupportedValueType;
    }
    const names = value as string[];

    if (names.length === 0) {
      return null; // nothing to check
    }

    for (const name of names) {
      const field = this.newC.fields.getByName(name);
      if (field === null) {
        return NewError(
          "validation_missing_field",
          "Invalid or missing field {{.fieldName}}",
        ).setParams({ fieldName: name });
      }

      const [, ok] = findSingleColumnUniqueIndex(this.newC.indexes, name);
      if (!ok) {
        return NewError(
          "validation_missing_unique_constraint",
          "The field {{.fieldName}} doesn't have a UNIQUE constraint.",
        ).setParams({ fieldName: name });
      }
    }

    return null;
  };

  // note: value could be either *string or string
  checkRule = (value: unknown): ValidationError | null => {
    let vStr: string;
    if (value === null || value === undefined) {
      vStr = "";
    } else if (typeof value === "string") {
      vStr = value;
    } else {
      return ErrUnsupportedValueType;
    }

    if (vStr === "") {
      return null; // nothing to check
    }

    return checkRuleExpr(this.app, this.newC, vStr);
  };

  ensureNoSystemRuleChange(oldRule: string | null): RuleFunc {
    return (value) => {
      if (this.original.isNew() || !this.original.system) {
        return null; // not an update of a system collection
      }

      // *string
      if (value !== null && value !== undefined && typeof value !== "string") {
        return ErrUnsupportedValueType;
      }
      const rule = value ?? null;

      if (
        (rule === null && oldRule === null) ||
        (rule !== null && oldRule !== null && rule === oldRule)
      ) {
        return null;
      }

      return NewError(
        "validation_collection_system_rule_change",
        "System collection API rule cannot be changed.",
      );
    };
  }

  checkIndexes = (value: unknown): Error | null => {
    const indexes = Array.isArray(value) ? (value as string[]) : [];

    if (this.newC.isView() && indexes.length > 0) {
      return NewError(
        "validation_indexes_not_supported",
        "View collections don't support indexes.",
      );
    }

    const duplicatedNames = new Set<string>();
    const duplicatedDefinitions = new Set<string>();

    for (const [i, rawIndex] of indexes.entries()) {
      const parsed = parseIndex(rawIndex);

      // always set a table name because it is ignored anyway in order to keep it in sync with the collection name
      parsed.tableName = "validator";

      if (!parsed.isValid()) {
        return new Errors({
          [String(i)]: NewError(
            "validation_invalid_index_expression",
            "Invalid CREATE INDEX expression.",
          ),
        });
      }

      if (duplicatedNames.has(toLower(parsed.indexName))) {
        return new Errors({
          [String(i)]: NewError(
            "validation_duplicated_index_name",
            "The index name already exists.",
          ),
        });
      }
      duplicatedNames.add(toLower(parsed.indexName));

      // ensure that the index name is not used in another collection
      let usedTblName = "";
      try {
        const [tblName] = this.app.databases
          .concurrentDB()
          .select("tbl_name")
          .from("sqlite_master")
          .andWhere(new HashExp({ type: "index" }))
          .andWhere(
            newExp("LOWER([[tbl_name]])!=LOWER({:oldName})", { oldName: this.original.name }),
          )
          .andWhere(newExp("LOWER([[tbl_name]])!=LOWER({:newName})", { newName: this.newC.name }))
          .andWhere(newExp("LOWER([[name]])=LOWER({:indexName})", { indexName: parsed.indexName }))
          .limit(1)
          .row();
        usedTblName = typeof tblName === "string" ? tblName : "";
      } catch {
        usedTblName = "";
      }
      if (usedTblName !== "") {
        return new Errors({
          [String(i)]: NewError(
            "validation_existing_index_name",
            "The index name is already used in {{.usedTableName}} collection.",
          ).setParams({ usedTableName: usedTblName }),
        });
      }

      // reset non-important identifiers
      parsed.schemaName = "validator";
      parsed.indexName = "validator";
      const parsedDef = parsed.build();

      if (duplicatedDefinitions.has(parsedDef)) {
        return new Errors({
          [String(i)]: NewError(
            "validation_duplicated_index_definition",
            "The index definition already exists.",
          ),
        });
      }
      duplicatedDefinitions.add(parsedDef);

      // note: we don't check the index table name because it is always
      // overwritten by the SyncRecordTableSchema to allow
      // easier partial modifications (eg. changing only the collection name).
    }

    // ensure that unique indexes on system fields are not changed or removed
    if (!this.original.isNew()) {
      oldIndexesLoop: for (const oldIndex of this.original.indexes) {
        const oldParsed = parseIndex(oldIndex);
        if (!oldParsed.unique) {
          continue;
        }

        // reset collate and sort since they are not important for the unique constraint
        for (const column of oldParsed.columns) {
          column.collate = "";
          column.sort = "";
        }

        const oldParsedStr = oldParsed.build();

        for (const column of oldParsed.columns) {
          for (const f of this.original.fields) {
            if (!f.getSystem() || !equalFold(column.name, f.getName())) {
              continue;
            }

            let hasMatch = false;
            for (const newIndex of this.newC.indexes) {
              const newParsed = parseIndex(newIndex);

              // exclude the non-important identifiers from the check
              newParsed.schemaName = oldParsed.schemaName;
              newParsed.indexName = oldParsed.indexName;
              newParsed.tableName = oldParsed.tableName;

              // exclude partial constraints
              newParsed.where = oldParsed.where;

              // reset collate and sort
              for (const c of newParsed.columns) {
                c.collate = "";
                c.sort = "";
              }

              if (oldParsedStr === newParsed.build()) {
                hasMatch = true;
                break;
              }
            }

            if (!hasMatch) {
              return NewError(
                "validation_invalid_unique_system_field_index",
                "Unique index definition on system fields ({{.fieldName}}) is invalid or missing.",
              ).setParams({ fieldName: f.getName() });
            }

            continue oldIndexesLoop;
          }
        }
      }
    }

    // check for required indexes
    //
    // note: this is in case the indexes were removed manually when creating/importing new auth collections
    // and technically it is not necessary because on app.Save() the missing indexes will be reinserted by the system collection hook
    if (this.newC.isAuth()) {
      const requiredNames = [FieldNameTokenKey, FieldNameEmail];
      for (const name of requiredNames) {
        const [, ok] = findSingleColumnUniqueIndex(indexes, name);
        if (!ok) {
          return NewError(
            "validation_missing_required_unique_index",
            `Missing required unique index for field "{{.fieldName}}".`,
          ).setParams({ fieldName: name });
        }
      }
    }

    return null;
  };

  validateOptions(): Error | null {
    switch (this.newC.type) {
      case CollectionTypeAuth:
        return validateAuthOptions(this.newC, this);
      case CollectionTypeView:
        return validateViewOptions(this.newC, this);
    }

    return null;
  }
}

// core/field.go checkForVia, with Go's strings.ToLower (the name reaches
// it before the name pattern check)
function checkForVia(value: unknown): ValidationError | null {
  const v = typeof value === "string" ? value : "";
  if (v === "") {
    return null;
  }

  if (toLower(v).includes("_via_")) {
    return NewError("validation_found_via", `The value cannot contain "_via_".`);
  }

  return null;
}

// -------------------------------------------------------------------

// checkRule's rule expression check: the rule is built with
// NewRecordFieldResolver(app, collection, &RequestInfo{}, true) and
// search.FilterData(rule).BuildExpr(r); an error is a
// "validation_invalid_rule" error with the raw error text.
function checkRuleExpr(
  app: CollectionsApp,
  collection: Collection,
  rule: string,
): ValidationError | null {
  const r = newRecordFieldResolver(app, collection, new RequestInfo(), true);
  try {
    filterBuildExpr(rule, r, r.filterOptions());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NewError("validation_invalid_rule", "Invalid rule. Raw error: " + message);
  }

  return null;
}
