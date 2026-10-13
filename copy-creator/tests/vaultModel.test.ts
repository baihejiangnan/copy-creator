import test from "node:test";
import assert from "node:assert/strict";
import { createVaultEntry, moveVaultField, vaultSummary, vaultFieldLabel } from "../src/lib/vaultModel.ts";

const translate = (key: string) => key;
test("a server has only address and private password, with explicit optional identity links", () => {
  const entry = createVaultEntry("server", translate, ["work", "work", "personal"]);
  assert.equal(entry.kind, "entry"); assert.equal(entry.payload_version, 2); assert.equal(entry.fields.length, 2);
  assert.deepEqual(entry.identity_ids, ["work", "personal"]);
  assert.deepEqual(entry.fields.map(field => [field.type, field.sensitive]), [["text", false], ["secret", true]]);
  assert.equal(entry.website, ""); assert.equal(entry.password, "");
});
test("identity templates cannot inherit identity links or service passwords", () => {
  const entry = createVaultEntry("identityWork", translate, ["other"]);
  assert.equal(entry.kind, "identity"); assert.deepEqual(entry.identity_ids, []);
  assert.equal(entry.fields.length, 4); assert.equal(entry.summary_field_id, entry.fields[0].id);
  assert.equal(entry.fields[2].value, ""); assert.equal(entry.fields[2].sensitive, true);
});
test("custom starts empty and field IDs survive reordering and edits", () => {
  assert.equal(createVaultEntry("custom", translate).fields.length, 0);
  const entry = createVaultEntry("server", translate); const original = entry.fields.map(field => field.id);
  const moved = moveVaultField(entry.fields, original[1], -1);
  assert.deepEqual(moved.map(field => field.id), original.toReversed()); assert.deepEqual(entry.fields.map(field => field.id), original);
  assert.equal(moveVaultField(entry.fields, original[0], -1), entry.fields);
});
test("summary falls back after its field becomes sensitive without altering values", () => {
  const entry = createVaultEntry("server", translate); entry.fields[0].value = " 2001:db8::24 "; entry.fields[1].value = "DEMO ONLY";
  entry.summary_field_id = entry.fields[1].id; assert.equal(vaultSummary(entry), " 2001:db8::24 ");
  entry.fields[0].sensitive = true; assert.equal(vaultSummary(entry), ""); assert.equal(entry.fields[0].value, " 2001:db8::24 ");
  const field = entry.fields[0]; field.purpose = "legacy_base:email";
  assert.equal(vaultFieldLabel(field, translate), "vault2.fields.email");
  field.purpose = ""; field.label = "My custom email"; assert.equal(vaultFieldLabel(field, translate), field.label);
});
