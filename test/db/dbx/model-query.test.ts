// Upstream: pocketbase/dbx v1.13.0 model_query_test.go
//
// Models declare their columns (src/db/dbx/struct.ts), so the Go cases for
// sql.Null* fields and embedded structs are covered by the nullable fields
// of CustomerPtr. Insert/Update attrs and Exclude take column names.

import { expect, test } from "bun:test";

import { HashExp } from "@/db/dbx/expression";
import { NoRowsError } from "@/db/dbx/rows";
import { MissingPKError } from "@/db/dbx/select";
import { Customer, CustomerPtr, Item } from "@test/db/dbx/models";
import { getPreparedDB } from "@test/db/support";

test("TestModelQuery_Insert", () => {
  const db = getPreparedDB();

  const name = "test";
  const email = "test@example.com";

  {
    // inserting normally
    const customer = new Customer();
    customer.name = name;
    customer.email = email;
    db.model(customer).insert();
    expect(customer.id).toBe(4);
    const c = db
      .select()
      .from("customer")
      .where(new HashExp({ ID: 4 }))
      .one(new Customer());
    expect(c.name).toBe(name);
    expect(c.email).toBe(email);
    expect(c.status).toBe(0);
    expect(c.address).toBeNull();
  }

  {
    // inserting with nullable fields
    const customer = new CustomerPtr();
    customer.name = name;
    customer.email = email;
    db.model(customer).insert();
    expect(customer.id).toBe(5);
    const c = db
      .select()
      .from("customer")
      .where(new HashExp({ ID: 4 }))
      .one(new CustomerPtr());
    expect(c.name).toBe(name);
    expect(c.email).toBe(email);
    expect(c.status).toBe(0);
    expect(c.address).toBeNull();
  }

  {
    // inserting with an explicit primary key
    const customer = new CustomerPtr();
    customer.id = 100;
    customer.email = email;
    customer.name = name;
    customer.status = 1;
    db.model(customer).insert();
    expect(customer.id).toBe(100);
    const c = db
      .select()
      .from("customer")
      .where(new HashExp({ ID: 100 }))
      .one(new CustomerPtr());
    expect(c.name).toBe(name);
    expect(c.email).toBe(email);
    expect(c.status).toBe(1);
    expect(c.address).toBeNull();
  }

  {
    // inserting with include/exclude fields
    const customer = new Customer();
    customer.name = name;
    customer.email = email;
    customer.status = 1;
    db.model(customer).exclude("name").insert("name", "email");
    expect(customer.id).toBe(101);
    const c = db
      .select()
      .from("customer")
      .where(new HashExp({ ID: 101 }))
      .one(new Customer());
    expect(c.name).toBe("");
    expect(c.email).toBe(email);
    expect(c.status).toBe(0);
    expect(c.address).toBeNull();
  }

  db.close();
});

test("TestModelQuery_Update", () => {
  const db = getPreparedDB();

  let id = 2;
  const name = "test";
  const email = "test@example.com";
  {
    // updating normally
    const customer = new Customer();
    customer.id = id;
    customer.name = name;
    customer.email = email;
    db.model(customer).update();
    const c = db
      .select()
      .from("customer")
      .where(new HashExp({ ID: id }))
      .one(new Customer());
    expect(c.name).toBe(name);
    expect(c.email).toBe(email);
    expect(c.status).toBe(0);
  }

  {
    // updating without primary keys
    const item2 = new Item();
    item2.name = name;
    expect(() => db.model(item2).update()).toThrow(MissingPKError);
  }

  {
    // updating all fields
    const customer = new CustomerPtr();
    customer.id = id;
    customer.name = name;
    customer.email = email;
    db.model(customer).update();
    expect(customer.id).toBe(id);
    const c = db
      .select()
      .from("customer")
      .where(new HashExp({ ID: id }))
      .one(new CustomerPtr());
    expect(c.name).toBe(name);
    expect(c.email).toBe(email);
    expect(c.status).toBeNull();
  }

  {
    // updating selected fields only
    id = 3;
    const customer = new CustomerPtr();
    customer.id = id;
    customer.name = name;
    customer.email = email;
    db.model(customer).update("name", "email");
    expect(customer.id).toBe(id);
    const c = db
      .select()
      .from("customer")
      .where(new HashExp({ ID: id }))
      .one(new CustomerPtr());
    expect(c.name).toBe(name);
    expect(c.email).toBe(email);
    expect(c.status).toBe(2);
  }

  db.close();
});

test("TestModelQuery_Delete", () => {
  const db = getPreparedDB();

  const customer = new Customer();
  customer.id = 2;
  db.model(customer).delete();
  expect(() =>
    db
      .select()
      .from("customer")
      .where(new HashExp({ ID: 2 }))
      .one(new Customer()),
  ).toThrow(NoRowsError);

  {
    // deleting without primary keys
    const item2 = new Item();
    expect(() => db.model(item2).delete()).toThrow(MissingPKError);
  }

  db.close();
});
