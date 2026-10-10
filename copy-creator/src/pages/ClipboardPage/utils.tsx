import type { ReactElement } from "react";
import { Icons } from "../../components/Icons";

export function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

export function getFileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export const TYPE_META: Readonly<Record<string, { readonly icon: ReactElement; readonly color: string }>> = {
  text: { icon: Icons.clipboard, color: "#007AFF" },
  image: { icon: Icons.image, color: "#34C759" },
  link: { icon: Icons.link, color: "#FF9500" },
  explorer: { icon: Icons.link, color: "#00A6A6" },
  file: { icon: Icons.file, color: "#AF52DE" },
};
