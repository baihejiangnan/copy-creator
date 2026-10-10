export interface NoteRef {
  readonly id: string;
  readonly kind: "file" | "url";
  readonly target: string;
  readonly display_name: string;
}
export interface NoteDraft {
  readonly title: string;
  readonly body: string;
  readonly refs: readonly NoteRef[];
}
export interface NoteSource {
  kind: string;
  record_id: string;
  source_app: string;
  captured_at_ms: number;
}
export interface NoteSummary {
  id: string;
  title: string;
  summary: string;
  char_count: number;
  byte_count: number;
  created_at_ms: number;
  updated_at_ms: number;
  revision: number;
  archived_at_ms: number | null;
  deleted_at_ms: number | null;
  ref_count: number;
  group_id?: string | null;
  starred?: boolean;
}
export interface Note extends NoteSummary {
  body: string;
  refs: NoteRef[];
  source: NoteSource | null;
}
export type NoteFilter = "active" | "archived" | "trash" | "ungrouped" | "starred";
export type NoteSort = "updated" | "created";
export type NoteAction = "archive" | "unarchive" | "delete" | "restore";
export interface NoteCursor { sort_at_ms: number; id: string }
export interface NotePage { records: NoteSummary[]; next_cursor: NoteCursor | null }
export interface StorageResult<T> { storage_epoch: number; value: T }
export interface NoteMutation { note: Note; mutation_id: string; applied: boolean }
export interface NoteFailure { code: string; current_revision?: number }
