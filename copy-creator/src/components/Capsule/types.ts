export type CapsuleKind = "url" | "file" | "folder";

export interface CapsuleShowPayload {
  kind: CapsuleKind;
  /** Full original text, never truncated. */
  text: string;
  /** Text prepared for display, already shortened. */
  display: string;
  durationMs: number;
}

/** Shipped fallbacks under public/, used when no custom icon is configured. */
export const DEFAULT_ICONS: Record<CapsuleKind, string> = {
  url: "/capsule-icons/link.svg",
  file: "/capsule-icons/file.svg",
  folder: "/capsule-icons/folder.svg",
};

export const OPEN_LABEL_KEYS: Record<CapsuleKind, string> = {
  url: "capsule.openUrl",
  file: "capsule.openFile",
  folder: "capsule.openFolder",
};
