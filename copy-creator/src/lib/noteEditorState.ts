import { EditorState } from "@codemirror/state";
import { history, historyKeymap, insertNewline, standardKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";

// Explicit LF splitting preserves existing CR/CRLF bytes in the coordinator's
// raw text. No language parser, auto-indent or formatting changes plain notes.
export const notePlainTextExtensions = [
  EditorState.lineSeparator.of("\n"), history(),
  keymap.of([{ key: "Enter", run: insertNewline, shift: insertNewline },
    ...standardKeymap.filter(binding => binding.key !== "Enter"), ...historyKeymap]),
];
