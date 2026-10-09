import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ClipboardPage from "./pages/ClipboardPage";
import VaultSession from "./components/VaultSession";
import { useVaultStore } from "./stores/vaultStore";
import ClipboardLimitDialog from "./components/ClipboardLimitDialog";
import SettingsSaveStatus from "./components/SettingsSaveStatus";
import { useSettingsEditorStore } from "./stores/settingsEditorStore";
import { useUpdateStore } from "./stores/updateStore";
import ApiKeyToast from "./components/ApiKeyToast";
import { useSettingsStore } from "./stores/settingsStore";
import { Icons } from "./components/Icons";
import i18n from "./i18n";
import { saveBarrier, startLifecycle } from "./lib/lifecycle";
import LifecycleStatus from "./components/LifecycleStatus";
import { refreshWindowVisibility } from "./lib/documentVisible";
import { invokeStorage, getStorageIdentity, isCurrentStorageIdentity, onStorageIdentity, type StorageEvent } from "./lib/storageIdentity";
const NotesPage = React.lazy(() => import("./pages/NotesPage"));
const PhrasePage = React.lazy(() => import("./pages/PhrasePage"));
const TranslationPage = React.lazy(() => import("./pages/TranslationPage"));
const VaultPage = React.lazy(() => import("./pages/VaultPage"));
const SettingsContent = React.lazy(() => import("./components/SettingsContent"));
const AboutDialog = React.lazy(() => import("./components/AboutDialog"));

const PANEL_MAP: Record<string, { titleKey: string; component: React.ReactNode }> = {
  clipboard: { titleKey: "tabs.clipboard", component: <ClipboardPage /> },
  notes: { titleKey: "tabs.notes", component: <NotesPage /> },
  phrases: { titleKey: "tabs.phrases", component: <PhrasePage /> },
  translate: { titleKey: "tabs.translate", component: <TranslationPage /> },
  vault: { titleKey: "tabs.vault", component: <VaultPage /> },
};

const NAV_ITEMS = [
  { panelType: "clipboard" },
  { panelType: "notes" },
  { panelType: "phrases" },
  { panelType: "translate" },
  { panelType: "vault" },
] as const;

function App() {
  const barrier = useSyncExternalStore(saveBarrier.subscribe, saveBarrier.getSnapshot);
  const { t } = useTranslation();
  const [activePanel, setActivePanel] = useState<string>("clipboard");
  const [unreadCount, setUnreadCount] = useState(0);
  const { themeMode, toggleTheme, loadSettings } = useSettingsStore();
  const [isPinned, setIsPinned] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const updateAvailable = useUpdateStore((state) => state.result?.status === "available");
  const settingsSaveFailed = useSettingsEditorStore((state) => Object.keys(state.errors).length > 0);
  const markReadInFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let disposed = false;
    let version = 0;
    const clear = onStorageIdentity(() => {
      version++;
      setPasteFailed(false);
    });
    const unlisten = listen<StorageEvent<boolean>>("clipboard-paste-failed", ({ payload }) => {
      if (disposed || payload?.value !== true || !isCurrentStorageIdentity(payload.storage_epoch)) return;
      const current = ++version;
      setPasteFailed(true);
      const main = getCurrentWindow();
      void main.show().then(() => {
        if (!disposed && current === version && isCurrentStorageIdentity(payload.storage_epoch)) return main.setFocus();
      }).catch(() => {});
    });
    return () => {
      disposed = true;
      clear();
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (activePanel !== "notes") return;
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing || saveBarrier.getSnapshot().busy) return;
      if (event.key.toLowerCase() !== "n" && event.key !== "Enter") return;
      event.preventDefault();
      const create = event.key.toLowerCase() === "n";
      void import("./stores/notesWorkspace").then(async ({ useNotesWorkspace }) => {
        await useNotesWorkspace.getState().initialize();
        const workspace = useNotesWorkspace.getState();
        if (create) workspace.create();
        else if (workspace.selectedId) await workspace.coordinator?.flush(workspace.selectedId).catch(workspace.setError);
      });
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [activePanel]);

  useEffect(() => {
    const openNote = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      if (typeof id !== "string") return;
      React.startTransition(() => setActivePanel("notes"));
      void import("./stores/notesWorkspace").then(async ({ useNotesWorkspace }) => {
        await useNotesWorkspace.getState().initialize(); await useNotesWorkspace.getState().open(id);
      });
    };
    window.addEventListener("open-note", openNote);
    return () => window.removeEventListener("open-note", openNote);
  }, []);

  useEffect(() => {
    void useUpdateStore.getState().start();
    void startLifecycle().catch(() => {});
  }, []);

  useEffect(() => {
    if (activePanel !== "vault") useVaultStore.getState().clearSelected();
  }, [activePanel]);

  const markClipboardRead = useCallback(() => {
    if (markReadInFlightRef.current) return markReadInFlightRef.current;
    const request = getStorageIdentity().then(async (epoch) => {
      await invokeStorage<void>("mark_clipboard_read");
      if (isCurrentStorageIdentity(epoch)) setUnreadCount(0);
    })
      .catch((e) => console.error("Failed to mark clipboard as read:", e))
      .finally(() => {
        markReadInFlightRef.current = null;
      });
    markReadInFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    const unlisten = listen("show-clipboard", () => {
      setActivePanel("clipboard");
      void markClipboardRead();
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [markClipboardRead]);

  useEffect(() => {
    let disposed = false;
    const cleanup: Array<() => void> = [];
    let version = 0;
    const refreshUnread = async () => {
      const current = ++version;
      const epoch = await getStorageIdentity();
      const count = await invoke<number>("get_clipboard_unread_count");
      if (!disposed && current === version && isCurrentStorageIdentity(epoch)) setUnreadCount(count);
    };
    cleanup.push(onStorageIdentity(() => {
      setUnreadCount(0);
      void refreshUnread().catch(console.error);
    }));
    void refreshUnread().catch(console.error);
    listen<StorageEvent<number>>("clipboard-unread-changed", ({ payload }) => {
      if (!disposed && isCurrentStorageIdentity(payload?.storage_epoch)) {
        version++;
        setUnreadCount(payload.value);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup.push(unlisten);
    });

    const currentWindow = getCurrentWindow();
    currentWindow.onFocusChanged(({ payload: focused }) => {
      if (focused && activePanel === "clipboard") markClipboardRead();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup.push(unlisten);
    });
    Promise.all([currentWindow.isVisible(), currentWindow.isFocused()]).then(
      ([visible, focused]) => {
        if (!disposed && visible && focused && activePanel === "clipboard") {
          markClipboardRead();
        }
      },
    );

    return () => {
      disposed = true;
      cleanup.forEach((unlisten) => unlisten());
    };
  }, [activePanel, markClipboardRead]);

  useEffect(() => {
    loadSettings().then(() => {
      const lang = useSettingsStore.getState().language;
      if (lang && lang !== i18n.language) {
        i18n.changeLanguage(lang);
      }
    });
  }, [loadSettings]);

  const SIDEBAR_MIN = 60;
  const SIDEBAR_MAX = 130;
  const SIDEBAR_DEFAULT = 60;
  const COLLAPSE_THRESHOLD = 80;
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode);
  }, [themeMode]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [sidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - dragStartX.current;
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStartWidth.current + delta));
      const el = sidebarRef.current;
      if (el) {
        el.style.width = `${newWidth}px`;
        el.style.minWidth = `${newWidth}px`;
        if (newWidth <= COLLAPSE_THRESHOLD) {
          el.classList.add("collapsed");
        } else {
          el.classList.remove("collapsed");
        }
      }
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const el = sidebarRef.current;
      if (el) {
        const finalWidth = parseFloat(el.style.width);
        if (!isNaN(finalWidth)) {
          setSidebarWidth(finalWidth);
          setIsCollapsed(finalWidth <= COLLAPSE_THRESHOLD);
        }
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const handleSettingsClick = () => React.startTransition(() => setActivePanel("settings"));

  const handleHide = async () => {
    void saveBarrier.hintFlush();
    const vault = useVaultStore.getState();
    if (vault.status?.unlocked || vault.busy) await vault.lock();
    await invoke("hide_main_window");
  };

  const handleMinimize = async () => {
    void saveBarrier.hintFlush();
    const vault = useVaultStore.getState();
    if (vault.status?.unlocked || vault.busy) await vault.lock();
    await getCurrentWindow().minimize();
    await refreshWindowVisibility();
  };

  const handleTogglePin = async () => {
    try {
      const next = await invoke<boolean>("toggle_always_on_top");
      setIsPinned(next);
    } catch (e) {
      console.error("Failed to toggle pin:", e);
    }
  };

  const panelInfo = activePanel !== "settings" ? PANEL_MAP[activePanel] : null;
  const isSettingsPanel = activePanel === "settings";

  return (
    <>
    <div inert={barrier.busy} style={{ display: "contents" }}>
    <div className="app-container">
      <div
        ref={sidebarRef}
        className={`sidebar ${isCollapsed ? "collapsed" : ""}`}
        style={{ width: sidebarWidth, minWidth: sidebarWidth }}
      >
        <div className="sidebar-header">
          <img
            className="sidebar-logo"
            src="/logo_top.png"
            alt="logo"
            draggable={false}
          />
          <span className="sidebar-brand">{t("brand.name")}</span>
        </div>

        <div className="sidebar-nav">
          {NAV_ITEMS.map((item) => {
            const iconKey = item.panelType as keyof typeof Icons;
            const titleKey = `tabs.${item.panelType}`;
            const isActive = !isSettingsPanel && activePanel === item.panelType;
            return (
              <button
                key={item.panelType}
                className={`sidebar-nav-item ${isActive ? "active" : ""}`}
                onClick={() => {
                  React.startTransition(() => setActivePanel(item.panelType));
                  if (item.panelType === "clipboard") markClipboardRead();
                }}
                title={t(titleKey)}
              >
                <span className="sidebar-nav-icon">
                  {Icons[iconKey]}
                  {item.panelType === "clipboard" && unreadCount > 0 && (
                    <span className="sidebar-unread-badge">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </span>
                <span className="sidebar-nav-label">{t(titleKey)}</span>
              </button>
            );
          })}
        </div>

        <div className="sidebar-footer">
          <button className={`sidebar-footer-item ${aboutOpen ? "active" : ""}`}
            onClick={() => setAboutOpen(true)}
            title={updateAvailable ? t("updates.sidebarAvailable") : t("about.title")}
            aria-label={t("about.title")} aria-haspopup="dialog">
            <span className="sidebar-footer-icon about-sidebar-icon">
              {Icons.about}
              {updateAvailable && <span className="update-dot" />}
            </span>
            <span className="sidebar-footer-label">{t("about.title")}</span>
          </button>
          <button
            className={`sidebar-footer-item ${isSettingsPanel ? "active" : ""}`}
            onClick={handleSettingsClick}
            title={t("settings.title")}
          >
            <span className="sidebar-footer-icon">{Icons.settings}</span>
            <span className="sidebar-footer-label">{t("settings.title")}</span>
          </button>
          <button
            className="sidebar-footer-item"
            onClick={toggleTheme}
            title={themeMode === "light" ? t("settings.dark") : t("settings.light")}
          >
            <span className="sidebar-footer-icon">
              {themeMode === "light" ? Icons.moon : Icons.sun}
            </span>
            <span className="sidebar-footer-label">
              {themeMode === "light" ? t("settings.dark") : t("settings.light")}
            </span>
          </button>
          <button
            className={`sidebar-footer-item ${isPinned ? "active" : ""}`}
            onClick={handleTogglePin}
            title={isPinned ? t("common.unpinWindow") : t("common.pinWindow")}
          >
            <span className="sidebar-footer-icon">
              {isPinned ? Icons.pin : Icons.pinOff}
            </span>
            <span className="sidebar-footer-label">
              {isPinned ? t("common.unpinWindow") : t("common.pinWindow")}
            </span>
          </button>
        </div>

        <div
          className="sidebar-resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>

      <div className="panel-area">
        <div className="panel-window-header">
          <h3 className="panel-window-title">
            {isSettingsPanel ? t("settings.title") : panelInfo ? t(panelInfo.titleKey) : ""}
          </h3>
          <div className="window-header-actions">
            <button
              className="window-minimize-btn"
              onClick={handleMinimize}
              title={t("common.minimize")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              className="window-close-btn"
              onClick={handleHide}
              title={t("common.hide")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div className="panel-window-body">
          <React.Suspense fallback={<span role="status">{t("notes.loading")}</span>}>
          {isSettingsPanel ? (
            <SettingsContent embedded />
          ) : (
            panelInfo?.component
          )}
          </React.Suspense>
        </div>
      </div>
    </div>
    <ApiKeyToast />
    <VaultSession />
    <ClipboardLimitDialog />
    {pasteFailed && <div className="clipboard-paste-toast" role="alert">
      <span>{t("clipboard.pasteFailed")}</span>
      <button className="project-link" onClick={() => setPasteFailed(false)}>{t("common.close")}</button>
    </div>}
    {settingsSaveFailed && !isSettingsPanel && <div className="settings-save-toast">
      <SettingsSaveStatus />
      <button className="project-link" onClick={handleSettingsClick}>{t("settings.title")}</button>
    </div>}
    {aboutOpen && <React.Suspense fallback={null}><AboutDialog onClose={() => setAboutOpen(false)} /></React.Suspense>}
    </div>
    <LifecycleStatus />
    </>
  );
}

export default App;
