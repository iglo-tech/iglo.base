// Upstream: core/record_field_resolver_runner.go
//
// Go's (result, error) returns are the result, and the error is thrown.

import type { Collection } from "@/collections/collection-model";
import { and, enclose, type Expression, HashExp, inExp, newExp } from "@/db/dbx/expression";
import { setOwn } from "@/db/dbx/query";
import {
  type Field,
  FieldNameCollectionId,
  FieldNameCollectionName,
  FieldNameEmail,
  FieldNameEmailVisibility,
  FieldNameId,
  FieldNameVerified,
  goQuote,
  isMultiValuer,
} from "@/fields/field";
import { FieldTypeGeoPoint } from "@/fields/geo-point";
import { FieldTypeJSON } from "@/fields/json";
import { FieldTypeRelation, RelationField } from "@/fields/relation";
import { ReplaceWithExpression } from "@/resolver/record-field-resolver-replace-expr";
import {
  changedModifier,
  eachModifier,
  goAtoi,
  lengthModifier,
  lowerModifier,
  ownValue,
  type RecordFieldResolver,
  requestAuthRecord,
  splitModifier,
} from "@/resolver/record-field-resolver";
import { filterBuildExpr } from "@/search/filter";
import { MultiMatchSubquery } from "@/search/multi-match-subquery";
import { NullFallbackDisabled, type ResolverResult } from "@/search/simple-field-resolver";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";
import { jsonArrayLength, jsonEach, jsonExtract } from "@/tools/dbutils/json";
import { columnify } from "@/tools/inflector/inflector";
import { existInSliceWithRegex, toInterfaceSlice, toUniqueStringSlice } from "@/tools/list/list";
import { pseudorandomString } from "@/tools/security/random";
import { toString } from "@/tools/types/cast";
import { marshal, textToBytes } from "@/tools/types/go-json";

// maxNestedRels defines the max allowed nested relations depth.
const maxNestedRels = 6;

// list of auth filter fields that don't require join with the auth
// collection or any other extra checks to be resolved.
const plainRequestAuthFields: ReadonlySet<string> = new Set([
  "@request.auth." + FieldNameId,
  "@request.auth." + FieldNameCollectionId,
  "@request.auth." + FieldNameCollectionName,
  "@request.auth." + FieldNameEmail,
  "@request.auth." + FieldNameEmailVisibility,
  "@request.auth." + FieldNameVerified,
]);

// parseAndRun starts a new one-off RecordFieldResolver.Resolve execution.
export function parseAndRun(fieldName: string, resolver: RecordFieldResolver): ResolverResult {
  const r = new Runner(fieldName, resolver);

  return r.run();
}

class Runner {
  private used = false; // indicates whether the runner was already executed

  // shared processing state
  // ---------------------------------------------------------------
  private activeProps: string[] = []; // holds the active props that remains to be processed
  private activeCollectionName = ""; // the last used collection name
  private activeTableAlias = ""; // the last used table alias
  private nullifyMisingField = false; // indicating whether to return null on missing field or return an error
  private withMultiMatch = false; // indicates whether to attach a MultiMatchSubquery condition to the ResolverResult
  private multiMatchActiveTableAlias = ""; // the last used multi-match table alias
  private multiMatch = new MultiMatchSubquery(); // the multi-match subquery expression generated from the fieldName

  constructor(
    private readonly fieldName: string, // the name of the single field expression the runner is responsible for
    private readonly resolver: RecordFieldResolver, // resolver is the shared expression fields resolver
  ) {}

  run(): ResolverResult {
    if (this.used) {
      throw new Error("the runner was already used");
    }

    if (
      this.resolver.allowedFields.length > 0 &&
      !existInSliceWithRegex(this.fieldName, this.resolver.allowedFields)
    ) {
      throw new Error(`failed to resolve field ${goQuote(this.fieldName)}`);
    }

    try {
      return this.runPrepared();
    } finally {
      this.used = true;
    }
  }

  private runPrepared(): ResolverResult {
    this.prepare();

    // check for @collection field (aka. non-relational join)
    // must be in the format "@collection.COLLECTION_NAME.FIELD[.FIELD2....]"
    if (this.activeProps[0] === "@collection") {
      return this.processCollectionField();
    }

    if (this.activeProps[0] === "@request") {
      // @todo consider returning an error instead?
      if (this.resolver.requestInfo === null) {
        return { identifier: "NULL" };
      }

      if (this.fieldName.startsWith("@request.auth.")) {
        return this.processRequestAuthField();
      }

      const totalProps = this.activeProps.length;

      if (this.fieldName.startsWith("@request.body.") && totalProps > 2) {
        const [name, modifier] = splitModifier(this.activeProps[2] as string);

        const bodyField = this.resolver.baseCollection.fields.getByName(name);
        if (bodyField === null) {
          return this.resolver.resolveStaticRequestField(...this.activeProps.slice(1));
        }

        // check for body relation field
        if (bodyField.type() === FieldTypeRelation && totalProps > 3) {
          return this.processRequestBodyRelationField(bodyField);
        }

        if (totalProps === 3) {
          // aka. last prop
          switch (modifier) {
            case eachModifier:
              return this.processRequestBodyEachModifier(bodyField);
            case lengthModifier:
              return this.processRequestBodyLengthModifier(bodyField);
            case lowerModifier:
              return this.processRequestBodyLowerModifier(bodyField);
            case changedModifier:
              return this.processRequestBodyChangedModifier(bodyField);
          }
        }
      }

      // some other @request.* static field
      return this.resolver.resolveStaticRequestField(...this.activeProps.slice(1));
    }

    // regular field
    return this.processActiveProps();
  }

  private prepare(): void {
    this.activeProps = this.fieldName.split(".");

    this.activeCollectionName = this.resolver.baseCollection.name;
    if (this.resolver.baseCollectionAlias === "") {
      this.activeTableAlias = columnify(this.activeCollectionName);
    } else {
      this.activeTableAlias = this.resolver.baseCollectionAlias;
    }

    // enable the ignore flag for missing @request.* fields for backward
    // compatibility and consistency with all @request.* filter fields and types
    this.nullifyMisingField = this.activeProps[0] === "@request";

    // prepare a multi-match subquery
    this.multiMatch = new MultiMatchSubquery({
      targetTableAlias: this.activeTableAlias,
      params: {},
    });
    this.multiMatch.fromTableName = columnify(this.activeCollectionName);
    this.multiMatch.fromTableAlias = "__mm_" + this.activeTableAlias;
    this.multiMatchActiveTableAlias = this.multiMatch.fromTableAlias;
    this.withMultiMatch = false;
  }

  private processCollectionField(): ResolverResult {
    if (this.activeProps.length < 3) {
      throw new Error(`invalid @collection field path in ${goQuote(this.fieldName)}`);
    }

    // nameOrId or nameOrId:alias
    const collectionParts = splitN(this.activeProps[1] as string, ":", 2);

    let collection: Collection;
    try {
      collection = this.resolver.loadCollection(collectionParts[0] as string);
    } catch {
      throw new Error(
        `failed to load collection ${goQuote(this.activeProps[1] as string)} from field path ${goQuote(this.fieldName)}`,
      );
    }

    this.activeCollectionName = collection.name;

    if (collectionParts.length === 2 && collectionParts[1] !== "") {
      this.activeTableAlias =
        columnify("__collection_alias_" + collectionParts[1]) + this.resolver.joinAliasSuffix;
    } else {
      this.activeTableAlias =
        columnify("__collection_" + this.activeCollectionName) + this.resolver.joinAliasSuffix;
    }

    this.withMultiMatch = true;

    // join the collection to the main query
    this.resolver.registerJoin(columnify(collection.name), this.activeTableAlias, null);

    // join the collection to the multi-match subquery
    this.multiMatchActiveTableAlias = "__mm_" + this.activeTableAlias;
    this.multiMatch.joins.push({
      tableName: columnify(collection.name),
      tableAlias: this.multiMatchActiveTableAlias,
    });

    // leave only the collection fields
    // aka. @collection.someCollection.fieldA.fieldB -> fieldA.fieldB
    this.activeProps = this.activeProps.slice(2);

    return this.processActiveProps();
  }

  private processRequestAuthField(): ResolverResult {
    const auth = requestAuthRecord(this.resolver.requestInfo);
    if (auth === null) {
      return { identifier: "NULL" };
    }

    // plain auth field
    // ---
    if (plainRequestAuthFields.has(this.fieldName)) {
      return this.resolver.resolveStaticRequestField(...this.activeProps.slice(1));
    }

    // resolve the auth collection field
    // ---
    const collection = auth.collection();

    this.activeCollectionName = collection.name;
    this.activeTableAlias =
      "__auth_" + columnify(this.activeCollectionName) + this.resolver.joinAliasSuffix;

    // join the auth collection to the main query
    this.resolver.registerJoin(
      columnify(this.activeCollectionName),
      this.activeTableAlias,
      // aka. __auth_users.id = :userId
      new HashExp({ [this.activeTableAlias + ".id"]: auth.id }),
    );

    // join the auth collection to the multi-match subquery
    this.multiMatchActiveTableAlias = "__mm_" + this.activeTableAlias;
    this.multiMatch.joins.push({
      tableName: columnify(this.activeCollectionName),
      tableAlias: this.multiMatchActiveTableAlias,
      on: new HashExp({ [this.multiMatchActiveTableAlias + ".id"]: auth.id }),
    });

    // leave only the auth relation fields
    // aka. @request.auth.fieldA.fieldB -> fieldA.fieldB
    this.activeProps = this.activeProps.slice(2);

    return this.processActiveProps();
  }

  // the body value of a field (Go's Body[name], nil when missing)
  private bodyValue(name: string): unknown {
    return ownValue(this.resolver.requestInfo?.body, name);
  }

  private processRequestBodyChangedModifier(bodyField: Field): ResolverResult {
    const name = bodyField.getName();

    const alias = `@request.body.${name}:isset = true && @request.body.${name} != ${name}`;

    const aliasExpr = filterBuildExpr(alias, this.resolver, this.resolver.filterOptions());

    const placeholder = "@changed@" + name + pseudorandomString(8);

    return {
      identifier: placeholder,
      nullFallback: NullFallbackDisabled,
      afterBuild: (expr: Expression): Expression =>
        new ReplaceWithExpression(placeholder, expr, aliasExpr),
    };
  }

  private processRequestBodyLowerModifier(bodyField: Field): ResolverResult {
    const rawValue = toString(this.bodyValue(bodyField.getName()));

    const placeholder = "infoLower" + bodyField.getName() + pseudorandomString(8);

    const params = {};
    setOwn(params, placeholder, rawValue);

    return {
      identifier: "LOWER({:" + placeholder + "})",
      params,
    };
  }

  private processRequestBodyLengthModifier(bodyField: Field): ResolverResult {
    if (!isMultiValuer(bodyField)) {
      throw new Error(
        `field ${goQuote(bodyField.getName())} doesn't support multivalue operations`,
      );
    }

    const bodyItems = toSlice(this.bodyValue(bodyField.getName()));

    return {
      identifier: String(bodyItems.length),
    };
  }

  private processRequestBodyEachModifier(bodyField: Field): ResolverResult {
    if (!isMultiValuer(bodyField)) {
      throw new Error(
        `field ${goQuote(bodyField.getName())} doesn't support multivalue operations`,
      );
    }
    const multiValuer = bodyField;

    const bodyItems = toSlice(this.bodyValue(bodyField.getName()));
    let bodyItemsRaw: Uint8Array;
    try {
      // a []byte param (bound as a BLOB, as Go's driver binds it)
      bodyItemsRaw = textToBytes(marshal(bodyItems));
    } catch {
      throw new Error(
        `cannot serialize the data for field ${goQuote(this.activeProps[2] as string)}`,
      );
    }

    const placeholder = "dataEach" + pseudorandomString(8);
    const cleanFieldName = columnify(bodyField.getName());
    const jeTable = `json_each({:${placeholder}})`;
    const jeAlias = "__dataEach_je_" + cleanFieldName + this.resolver.joinAliasSuffix;

    this.resolver.registerJoin(jeTable, jeAlias, null);

    const params = {};
    setOwn(params, placeholder, bodyItemsRaw);

    const result: ResolverResult = {
      identifier: `[[${jeAlias}.value]]`,
      params,
    };

    if (multiValuer.isMultiple()) {
      this.withMultiMatch = true;
    }

    if (this.withMultiMatch) {
      const placeholder2 = "mm" + placeholder;
      const jeTable2 = `json_each({:${placeholder2}})`;
      const jeAlias2 = "__mm_" + jeAlias;

      this.multiMatch.joins.push({
        tableName: jeTable2,
        tableAlias: jeAlias2,
      });
      setOwn(this.multiMatch.params, placeholder2, bodyItemsRaw);
      this.multiMatch.valueIdentifier = `[[${jeAlias2}.value]]`;

      result.multiMatchSubQuery = this.multiMatch;
    }

    return result;
  }

  private processRequestBodyRelationField(bodyField: Field): ResolverResult {
    if (!(bodyField instanceof RelationField)) {
      throw new Error(`failed to initialize data relation field ${goQuote(bodyField.getName())}`);
    }
    const relField = bodyField;

    let dataRelCollection: Collection;
    try {
      dataRelCollection = this.resolver.loadCollection(relField.collectionId);
    } catch {
      throw new Error(
        `failed to load collection ${goQuote(relField.collectionId)} from data field ${goQuote(relField.name)}`,
      );
    }

    let dataRelIds: string[] = [];
    const body = this.resolver.requestInfo?.body;
    if (this.resolver.requestInfo !== null && body !== null && body !== undefined) {
      if (Object.keys(body).length !== 0) {
        dataRelIds = toUniqueStringSlice(ownValue(body, relField.name));
      }
    }
    if (dataRelIds.length === 0) {
      return { identifier: "NULL" };
    }

    this.activeCollectionName = dataRelCollection.name;
    this.activeTableAlias =
      columnify("__data_" + dataRelCollection.name + "_" + relField.name) +
      this.resolver.joinAliasSuffix;

    // join the data rel collection to the main collection
    this.resolver.registerJoin(
      this.activeCollectionName,
      this.activeTableAlias,
      inExp(`[[${this.activeTableAlias}.id]]`, ...toInterfaceSlice(dataRelIds)),
    );

    if (relField.isMultiple()) {
      this.withMultiMatch = true;
    }

    // join the data rel collection to the multi-match subquery
    this.multiMatchActiveTableAlias = "__mm_" + this.activeTableAlias;
    this.multiMatch.joins.push({
      tableName: this.activeCollectionName,
      tableAlias: this.multiMatchActiveTableAlias,
      on: inExp(`[[${this.multiMatchActiveTableAlias}.id]]`, ...toInterfaceSlice(dataRelIds)),
    });

    // leave only the data relation fields
    // aka. @request.body.someRel.fieldA.fieldB -> fieldA.fieldB
    this.activeProps = this.activeProps.slice(3);

    return this.processActiveProps();
  }

  // @todo refactor and abstract lastProp processing with the support of field plugins
  private processActiveProps(): ResolverResult {
    const totalProps = this.activeProps.length;

    for (const [i, prop] of this.activeProps.entries()) {
      let collection: Collection;
      try {
        collection = this.resolver.loadCollection(this.activeCollectionName);
      } catch {
        throw new Error(`failed to resolve field ${goQuote(prop)}`);
      }

      // last prop
      if (i === totalProps - 1) {
        return this.finalizeActivePropsProcessing(collection, prop, i);
      }

      const field = collection.fields.getByName(prop);

      if (field !== null && field.getHidden() && !this.resolver.allowHiddenFields) {
        throw new Error(`non-filterable field ${goQuote(prop)}`);
      }

      // @todo consider moving to the finalizer and converting to "JSONExtractable" interface with optional extra validation for the remaining props?
      // json or geoPoint field -> treat the rest of the props as json path
      if (
        field !== null &&
        (field.type() === FieldTypeJSON || field.type() === FieldTypeGeoPoint)
      ) {
        let jsonPath = "";
        for (const [j, p] of this.activeProps.slice(i + 1).entries()) {
          if (goAtoi(p) !== null) {
            jsonPath += "[" + columnify(p) + "]";
          } else {
            if (j > 0) {
              jsonPath += ".";
            }
            jsonPath += columnify(p);
          }
        }

        const result: ResolverResult = {
          nullFallback: NullFallbackDisabled,
          identifier: jsonExtract(this.activeTableAlias + "." + columnify(prop), jsonPath),
        };

        if (this.withMultiMatch) {
          this.multiMatch.valueIdentifier = jsonExtract(
            this.multiMatchActiveTableAlias + "." + columnify(prop),
            jsonPath,
          );
          result.multiMatchSubQuery = this.multiMatch;
        }

        return result;
      }

      if (i >= maxNestedRels) {
        throw new Error(`max nested relations reached for field ${goQuote(prop)}`);
      }

      // check for back relation (eg. yourCollection_via_yourRelField)
      // -----------------------------------------------------------
      if (field === null) {
        const parts = viaRegex.exec(prop);
        if (parts === null || parts.length !== 3) {
          if (this.nullifyMisingField) {
            return { identifier: "NULL" };
          }
          throw new Error(`failed to resolve field ${goQuote(prop)}`);
        }

        let backCollection: Collection;
        try {
          backCollection = this.resolver.loadCollection(parts[1] as string);
        } catch {
          if (this.nullifyMisingField) {
            return { identifier: "NULL" };
          }
          throw new Error(`failed to load back relation field ${goQuote(prop)} collection`);
        }

        const backField = backCollection.fields.getByName(parts[2] as string);
        if (backField === null) {
          if (this.nullifyMisingField) {
            return { identifier: "NULL" };
          }
          throw new Error(`missing back relation field ${goQuote(parts[2] as string)}`);
        }

        if (backField.type() !== FieldTypeRelation) {
          if (this.nullifyMisingField) {
            return { identifier: "NULL" };
          }
          throw new Error(`invalid back relation field ${goQuote(parts[2] as string)}`);
        }

        if (backField.getHidden() && !this.resolver.allowHiddenFields) {
          throw new Error(`non-filterable back relation field ${goQuote(backField.getName())}`);
        }

        if (!(backField instanceof RelationField)) {
          throw new Error(
            `failed to initialize back relation field ${goQuote(backField.getName())}`,
          );
        }
        const backRelField = backField;
        if (backRelField.collectionId !== collection.id) {
          // https://ganigeorgiev.com/pocketbase/discussions/6590#discussioncomment-12496581
          if (this.nullifyMisingField) {
            return { identifier: "NULL" };
          }
          throw new Error(
            `invalid collection reference of a back relation field ${goQuote(backField.getName())}`,
          );
        }

        // join the back relation to the main query
        // ---
        const cleanProp = columnify(prop);
        const cleanBackFieldName = columnify(backRelField.name);

        const newTableAlias =
          this.activeTableAlias + "_" + cleanProp + this.resolver.joinAliasSuffix;
        const newCollectionName = columnify(backCollection.name);

        const isBackRelMultiple = backRelField.isMultiple();

        if (!isBackRelMultiple) {
          this.resolver.registerJoin(
            newCollectionName,
            newTableAlias,
            newExp(`[[${newTableAlias}.${cleanBackFieldName}]] = [[${this.activeTableAlias}.id]]`),
          );
        } else {
          const jeAlias = "__je_" + newTableAlias;
          this.resolver.registerJoin(
            newCollectionName,
            newTableAlias,
            newExp(
              `[[${this.activeTableAlias}.id]] IN (SELECT [[${jeAlias}.value]] FROM ${jsonEach(newTableAlias + "." + cleanBackFieldName)} {{${jeAlias}}})`,
            ),
          );
        }

        this.activeCollectionName = newCollectionName;
        this.activeTableAlias = newTableAlias;
        // ---

        // join the back relation to the multi-match subquery
        // ---
        if (isBackRelMultiple) {
          this.withMultiMatch = true; // enable multimatch if not already
        } else if (!this.withMultiMatch) {
          // additionally check if the rel field has a single column unique index;
          // if not - apply a multi-match check
          const [, hasUniqueIndex] = findSingleColumnUniqueIndex(
            backCollection.indexes,
            backRelField.name,
          );
          this.withMultiMatch = !hasUniqueIndex;
        }

        const newTableAlias2 =
          this.multiMatchActiveTableAlias + "_" + cleanProp + this.resolver.joinAliasSuffix;

        if (!isBackRelMultiple) {
          this.multiMatch.joins.push({
            tableName: newCollectionName,
            tableAlias: newTableAlias2,
            on: newExp(
              `[[${newTableAlias2}.${cleanBackFieldName}]] = [[${this.multiMatchActiveTableAlias}.id]]`,
            ),
          });
        } else {
          const jeAlias2 = "__je_" + newTableAlias2;
          this.multiMatch.joins.push({
            tableName: newCollectionName,
            tableAlias: newTableAlias2,
            on: newExp(
              `[[${this.multiMatchActiveTableAlias}.id]] IN (SELECT [[${jeAlias2}.value]] FROM ${jsonEach(newTableAlias2 + "." + cleanBackFieldName)} {{${jeAlias2}}})`,
            ),
          });
        }

        this.multiMatchActiveTableAlias = newTableAlias2;
        // ---

        continue;
      }
      // -----------------------------------------------------------

      // check for direct relation
      if (field.type() !== FieldTypeRelation) {
        throw new Error(`field ${goQuote(prop)} is not a valid relation`);
      }

      // join the relation to the main query
      // ---
      if (!(field instanceof RelationField)) {
        throw new Error(`failed to initialize relation field ${goQuote(prop)}`);
      }
      const relField = field;

      let relCollection: Collection;
      try {
        relCollection = this.resolver.loadCollection(relField.collectionId);
      } catch {
        throw new Error(`failed to load field ${goQuote(prop)} collection`);
      }

      // "id" lookups optimization for single relations to avoid unnecessary joins,
      // aka. "user.id" and "user" should produce the same query identifier
      if (
        !relField.isMultiple() &&
        // the penultimate prop is "id"
        i === totalProps - 2 &&
        this.activeProps[i + 1] === FieldNameId
      ) {
        return this.finalizeActivePropsProcessing(collection, relField.name, i);
      }

      const cleanFieldName = columnify(relField.name);
      const prefixedFieldName = this.activeTableAlias + "." + cleanFieldName;
      const newTableAlias =
        this.activeTableAlias + "_" + cleanFieldName + this.resolver.joinAliasSuffix;
      const newCollectionName = relCollection.name;

      if (!relField.isMultiple()) {
        this.resolver.registerJoin(
          columnify(newCollectionName),
          newTableAlias,
          newExp(`[[${newTableAlias}.id]] = [[${prefixedFieldName}]]`),
        );
      } else {
        const jeAlias = "__je_" + newTableAlias;

        this.resolver.registerJoin(jsonEach(prefixedFieldName), jeAlias, null);

        this.resolver.registerJoin(
          columnify(newCollectionName),
          newTableAlias,
          newExp(`[[${newTableAlias}.id]] = [[${jeAlias}.value]]`),
        );
      }

      this.activeCollectionName = newCollectionName;
      this.activeTableAlias = newTableAlias;
      // ---

      // join the relation to the multi-match subquery
      // ---
      if (relField.isMultiple()) {
        this.withMultiMatch = true; // enable multimatch if not already
      }

      const newTableAlias2 = this.multiMatchActiveTableAlias + "_" + cleanFieldName;
      const prefixedFieldName2 = this.multiMatchActiveTableAlias + "." + cleanFieldName;

      if (!relField.isMultiple()) {
        this.multiMatch.joins.push({
          tableName: columnify(newCollectionName),
          tableAlias: newTableAlias2,
          on: newExp(`[[${newTableAlias2}.id]] = [[${prefixedFieldName2}]]`),
        });
      } else {
        const jeAlias2 = this.multiMatchActiveTableAlias + "_" + cleanFieldName + "_je";
        this.multiMatch.joins.push(
          {
            tableName: jsonEach(prefixedFieldName2),
            tableAlias: jeAlias2,
          },
          {
            tableName: columnify(newCollectionName),
            tableAlias: newTableAlias2,
            on: newExp(`[[${newTableAlias2}.id]] = [[${jeAlias2}.value]]`),
          },
        );
      }

      this.multiMatchActiveTableAlias = newTableAlias2;
      // ---
    }

    throw new Error(`failed to resolve field ${goQuote(this.fieldName)}`);
  }

  private finalizeActivePropsProcessing(
    collection: Collection,
    prop: string,
    _propDepth: number,
  ): ResolverResult {
    const [name, modifier] = splitModifier(prop);

    const field = collection.fields.getByName(name);
    if (field === null) {
      if (this.nullifyMisingField) {
        return { identifier: "NULL" };
      }
      throw new Error(`unknown field ${goQuote(name)}`);
    }

    if (field.getHidden() && !this.resolver.allowHiddenFields) {
      throw new Error(`non-filterable field ${goQuote(name)}`);
    }

    const isMultivaluer = isMultiValuer(field);

    const cleanFieldName = columnify(field.getName());

    // arrayable fields with ":length" modifier
    // -------------------------------------------------------
    if (modifier === lengthModifier && isMultivaluer) {
      const jePair = this.activeTableAlias + "." + cleanFieldName;

      const result: ResolverResult = {
        identifier: jsonArrayLength(jePair),
      };

      if (this.withMultiMatch) {
        const jePair2 = this.multiMatchActiveTableAlias + "." + cleanFieldName;
        this.multiMatch.valueIdentifier = jsonArrayLength(jePair2);
        result.multiMatchSubQuery = this.multiMatch;
      }

      return result;
    }

    // arrayable fields with ":each" modifier
    // -------------------------------------------------------
    if (modifier === eachModifier && isMultivaluer) {
      const jePair = this.activeTableAlias + "." + cleanFieldName;
      const jeAlias =
        "__je_" + this.activeTableAlias + "_" + cleanFieldName + this.resolver.joinAliasSuffix;

      this.resolver.registerJoin(jsonEach(jePair), jeAlias, null);

      const result: ResolverResult = {
        identifier: `[[${jeAlias}.value]]`,
      };

      if (field.isMultiple()) {
        this.withMultiMatch = true;
      }

      if (this.withMultiMatch) {
        const jePair2 = this.multiMatchActiveTableAlias + "." + cleanFieldName;
        const jeAlias2 =
          "__je_" +
          this.multiMatchActiveTableAlias +
          "_" +
          cleanFieldName +
          this.resolver.joinAliasSuffix;

        this.multiMatch.joins.push({
          tableName: jsonEach(jePair2),
          tableAlias: jeAlias2,
        });
        this.multiMatch.valueIdentifier = `[[${jeAlias2}.value]]`;

        result.multiMatchSubQuery = this.multiMatch;
      }

      return result;
    }

    // default
    // -------------------------------------------------------
    const result: ResolverResult = {
      identifier: "[[" + this.activeTableAlias + "." + cleanFieldName + "]]",
    };

    if (this.withMultiMatch) {
      this.multiMatch.valueIdentifier =
        "[[" + this.multiMatchActiveTableAlias + "." + cleanFieldName + "]]";
      result.multiMatchSubQuery = this.multiMatch;
    }

    // allow querying only auth records with emails marked as public
    if (
      field.getName() === FieldNameEmail &&
      !this.resolver.allowHiddenFields &&
      collection.isAuth()
    ) {
      result.afterBuild = (expr: Expression): Expression =>
        enclose(
          and(expr, newExp(`[[${this.activeTableAlias}.${FieldNameEmailVisibility}]] = TRUE`)),
        );
    }

    // wrap in json_extract to ensure that top-level primitives
    // stored as json work correctly when compared to their SQL equivalent
    // (https://ganigeorgiev.com/pocketbase/discussions/4068)
    if (field.type() === FieldTypeJSON) {
      result.nullFallback = NullFallbackDisabled;
      result.identifier = jsonExtract(this.activeTableAlias + "." + cleanFieldName, "");
      if (this.withMultiMatch) {
        this.multiMatch.valueIdentifier = jsonExtract(
          this.multiMatchActiveTableAlias + "." + cleanFieldName,
          "",
        );
      }
    }

    // account for the ":lower" modifier
    if (modifier === lowerModifier) {
      result.identifier = "LOWER(" + result.identifier + ")";
      if (this.withMultiMatch) {
        this.multiMatch.valueIdentifier = "LOWER(" + this.multiMatch.valueIdentifier + ")";
      }
    }

    return result;
  }
}

const viaRegex = /^(\w+)_via_(\w+)$/;

// note: nil value is returned as empty slice
function toSlice(value: unknown): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return [...value];
  }
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  return [value];
}

// strings.SplitN(s, sep, n) for n > 0
function splitN(s: string, sep: string, n: number): string[] {
  const parts = s.split(sep);
  if (parts.length <= n) {
    return parts;
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(sep)];
}
