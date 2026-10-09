import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LatestQuery } from "./latestQuery";

// WebView2 may keep document.visibilityState="visible" after native hide.
// Focus is separate: a pinned, unfocused window stays active.
let nativeVisible = false;
let generation = 0;
let starting: Promise<void> | null = null;
const listeners = new Set<() => void>();
const queries = new LatestQuery<boolean>();
const publish = (visible: boolean) => {
  nativeVisible = visible;
  for (const listener of listeners) listener();
};
export async function refreshWindowVisibility() {
  const current = ++generation;
  try {
    const visible = await queries.run(String(current), async () => {
      const window = getCurrentWindow();
      const [shown, minimized] = await Promise.all([window.isVisible(), window.isMinimized()]);
      return shown && !minimized;
    });
    if (current === generation && visible !== undefined) publish(visible);
  } catch (error) { console.error("Window visibility unavailable:", error); }
}
function start() {
  if (starting) return starting;
  starting = (async () => {
    const stops: (() => void)[] = [];
    try {
      stops.push(await listen<boolean>("main-window-visibility", ({ payload }) => {
        generation++;
        publish(payload);
      }));
      const window = getCurrentWindow();
      stops.push(await window.onFocusChanged(() => { void refreshWindowVisibility(); }));
      stops.push(await window.onResized(() => { void refreshWindowVisibility(); }));
      document.addEventListener("visibilitychange", () => {
        for (const listener of listeners) listener();
        void refreshWindowVisibility();
      });
      await refreshWindowVisibility();
    } catch (error) {
      stops.forEach(stop => stop()); starting = null;
      console.error("Window visibility listener unavailable:", error);
    }
  })();
  return starting;
}
const subscribe = (listener: () => void) => {
  listeners.add(listener); void start();
  return () => { listeners.delete(listener); };
};
export const useWindowVisible = () => useSyncExternalStore(subscribe, () => nativeVisible && !document.hidden);
