import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { notePlainTextExtensions } from "../src/lib/noteEditorState.ts";

test("plain note edits retain CRLF, lone CR, trailing spaces and Unicode exactly", () => {
  const raw = "  中文😀\r\nnext\rlast  \n";
  let state = EditorState.create({ doc: raw, extensions: notePlainTextExtensions });
  assert.equal(state.doc.toString(), raw);
  state = state.update({ changes: { from: state.doc.length, insert: "末尾  " } }).state;
  assert.equal(state.doc.toString(), raw + "末尾  ");
  state = state.update({ changes: { from: 0, to: 2, insert: "\t" } }).state;
  assert.equal(state.doc.toString(), "\t" + raw.slice(2) + "末尾  ");
});
