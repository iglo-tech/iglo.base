// Translated from pocketbase/dbx v1.13.0, whose license follows:
//
// The MIT License (MIT)
//
// Copyright (c) 2016, Qiang Xue
// Copyright (c) 2022-present Gani Georgiev
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// Test models for the dbx tests: TypeScript versions of the Customer,
// CustomerPtr, Item and User structs of dbx's query_test.go and
// model_query_test.go. Go's pointer and sql.Null* fields become nullable
// fields.

import type { Params, Row } from "@/db/dbx/query";
import type { PostScanner, StructModel } from "@/db/dbx/struct";

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// Customer: ID int, Email string, Status int, Name string, Address sql.NullString
export class Customer implements StructModel, PostScanner {
  scanned = false;

  id = 0;
  email = "";
  status = 0;
  name = "";
  address: string | null = null;

  tableName(): string {
    return "customer";
  }

  dbColumns(): Params {
    return {
      id: this.id,
      email: this.email,
      status: this.status,
      name: this.name,
      address: this.address,
    };
  }

  dbScan(row: Row): void {
    if ("id" in row) this.id = num(row.id) ?? 0;
    if ("email" in row) this.email = str(row.email) ?? "";
    if ("status" in row) this.status = num(row.status) ?? 0;
    if ("name" in row) this.name = str(row.name) ?? "";
    if ("address" in row) this.address = str(row.address);
  }

  postScan(): void {
    this.scanned = true;
  }
}

// CustomerPtr: ID *int `db:"pk"`, Email *string, Status *int, Name string, Address *string
export class CustomerPtr implements StructModel {
  id: number | null = null;
  email: string | null = null;
  status: number | null = null;
  name = "";
  address: string | null = null;

  tableName(): string {
    return "customer";
  }

  dbPrimaryKey(): string[] {
    return ["id"];
  }

  dbColumns(): Params {
    return {
      id: this.id,
      email: this.email,
      status: this.status,
      name: this.name,
      address: this.address,
    };
  }

  dbScan(row: Row): void {
    if ("id" in row) this.id = num(row.id);
    if ("email" in row) this.email = str(row.email);
    if ("status" in row) this.status = num(row.status);
    if ("name" in row) this.name = str(row.name) ?? "";
    if ("address" in row) this.address = str(row.address);
  }
}

// Item: ID2 int, Name string (no primary key)
export class Item implements StructModel {
  id2 = 0;
  name = "";

  tableName(): string {
    return "item";
  }

  dbColumns(): Params {
    return { id2: this.id2, name: this.name };
  }

  dbScan(row: Row): void {
    if ("id2" in row) this.id2 = num(row.id2) ?? 0;
    if ("name" in row) this.name = str(row.name) ?? "";
  }
}

// User: ID int64, Email string, Created time.Time, Updated *time.Time
export class User implements StructModel {
  id = 0;
  email = "";
  created = "";
  updated: string | null = null;

  tableName(): string {
    return "user";
  }

  dbColumns(): Params {
    return { id: this.id, email: this.email, created: this.created, updated: this.updated };
  }

  dbScan(row: Row): void {
    if ("id" in row) this.id = num(row.id) ?? 0;
    if ("email" in row) this.email = str(row.email) ?? "";
    if ("created" in row) this.created = str(row.created) ?? "";
    if ("updated" in row) this.updated = str(row.updated);
  }
}
