import { useEffect, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { NOTE_BODY_MAX_BYTES } from "../../lib/noteCoordinator";
import { notePlainTextExtensions } from "../../lib/noteEditorState";

const external = Annotation.define<boolean>();
interface Props {
  value: string; label: string; readOnly: boolean;
  placeholderText?: string;
  onChange(value: string): boolean;
  onComposing(composing: boolean): void;
  onBlur(): void;
  onTooLarge(): void;
  focusTick?: number;
}

/** Keeps the full document in editor state and only draws the visible range.
 * The application coordinator remains the owner of recoverable/save state. */
export default function NoteBodyEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef(props);
  const initial = useRef(props);
  const currentText = useRef(props.value);
  const access = useRef(new Compartment());
  const description = useRef(new Compartment());
  useEffect(() => { if (props.focusTick !== undefined) view.current?.focus(); }, [props.focusTick]);
  useLayoutEffect(() => { callbacks.current = props; });
  useEffect(() => {
    const parent = host.current; if (!parent) return;
    let live = true;
    const editor = new EditorView({ parent, state: EditorState.create({
      doc: initial.current.value,
      extensions: [notePlainTextExtensions, EditorView.lineWrapping,
        access.current.of([EditorState.readOnly.of(initial.current.readOnly), EditorView.editable.of(!initial.current.readOnly)]),
        description.current.of([EditorView.contentAttributes.of({ "aria-label": initial.current.label, "aria-multiline": "true", spellcheck: "true" }), placeholder(initial.current.placeholderText ?? initial.current.label)]),
        EditorView.theme({
          "&": { height: "100%", color: "inherit", backgroundColor: "transparent", fontSize: "inherit" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.65", overflow: "auto" },
          ".cm-content": { padding: "9px", minHeight: "100%", caretColor: "var(--text-primary)" },
          ".cm-line": { padding: "0" },
          ".cm-placeholder": { color: "var(--text-secondary)" },
        }),
        EditorState.transactionFilter.of(transaction => {
          if (transaction.docChanged && !transaction.annotation(external) && transaction.newDoc.length > NOTE_BODY_MAX_BYTES) {
            callbacks.current.onTooLarge(); return [];
          }
          return transaction;
        }),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          if (update.transactions.some(transaction => transaction.annotation(external))) { currentText.current = text; return; }
          if (callbacks.current.onChange(text)) currentText.current = text;
          else {
            // Admission can fail during a barrier or when the recovery budget
            // is full. Restore the coordinator's accepted text, with an error
            // shown by the caller, outside this editor update stack.
            queueMicrotask(() => { if (live) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: currentText.current }, annotations: [external.of(true), Transaction.addToHistory.of(false)] }); });
          }
        }),
        EditorView.domEventHandlers({
          compositionstart: () => { callbacks.current.onComposing(true); return false; },
          compositionend: () => { callbacks.current.onComposing(false); return false; },
          blur: () => { callbacks.current.onBlur(); return false; },
        }),
      ],
    }) });
    view.current = editor;
    if (initial.current.focusTick !== undefined) editor.focus();
    return () => { live = false; view.current = null; callbacks.current.onComposing(false); editor.destroy(); };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && currentText.current !== props.value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value }, annotations: [external.of(true), Transaction.addToHistory.of(false)] });
    }
  }, [props.value]);
  useEffect(() => {
    view.current?.dispatch({ effects: access.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly), EditorView.contentAttributes.of({ "aria-readonly": String(props.readOnly) })]) });
  }, [props.readOnly]);
  useEffect(() => {
    view.current?.dispatch({ effects: description.current.reconfigure([EditorView.contentAttributes.of({ "aria-label": props.label, "aria-multiline": "true", spellcheck: "true" }), placeholder(props.placeholderText ?? props.label)]) });
  }, [props.label, props.placeholderText]);
  return <div className="notes-body-editor" ref={host} />;
}
