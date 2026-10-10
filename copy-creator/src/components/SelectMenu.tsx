import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface SelectOption<T> { value: T; label: string; color?: string }
interface Props<T> {
  options: SelectOption<T>[];
  value: T;
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  className?: string;
  onChange(value: T): void;
}

/** Shared, viewport-bounded menu for notebook groups and vault settings/templates. */
export default function SelectMenu<T extends string | null>({ options, value, disabled = false, title, ariaLabel, className = "", onChange }: Props<T>) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  const shown = open && !disabled;
  const closeAndFocus = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!shown || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const element = menu.current;
    const viewport = window.visualViewport;
    const startX = viewport?.offsetLeft ?? 0, startY = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    const menuWidth = Math.min(232, width - 24);
    const below = startY + height - anchor.bottom - 18, above = anchor.top - startY - 18;
    const placeBelow = below >= Math.min(240, element.scrollHeight) || below >= above;
    element.style.width = `${menuWidth}px`;
    element.style.maxHeight = `${Math.min(240, Math.max(0, placeBelow ? below : above))}px`;
    element.style.left = `${Math.max(startX + 12, Math.min(anchor.left, startX + width - menuWidth - 12))}px`;
    element.style.top = `${placeBelow ? anchor.bottom + 6 : anchor.top - element.offsetHeight - 6}px`;
    const current = element.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? element.querySelector<HTMLButtonElement>("button");
    current?.focus({ preventScroll: true });
    if (current) element.scrollTop = Math.max(0, current.offsetTop - element.clientHeight / 2);
  }, [shown, options.length]);

  useEffect(() => {
    if (!shown) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const close = () => setOpen(false);
    const anchor = trigger.current?.getBoundingClientRect();
    const scroll = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return;
      const current = trigger.current?.getBoundingClientRect();
      // Ignore a queued scroll event from bringing the trigger into view before opening.
      if (!anchor || !current || current.top !== anchor.top || current.left !== anchor.left) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.visualViewport?.addEventListener("resize", close);
    window.visualViewport?.addEventListener("scroll", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.visualViewport?.removeEventListener("resize", close);
      window.visualViewport?.removeEventListener("scroll", close);
    };
  }, [shown]);

  return <>
    <button ref={trigger} type="button" className={`app-select-trigger ${className}`} disabled={disabled} title={title ?? selected?.label}
      aria-label={`${ariaLabel}: ${selected?.label ?? ""}`} aria-haspopup="menu" aria-expanded={shown} aria-controls={shown ? menuId : undefined}
      onClick={() => setOpen(!shown)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
      }}>
      {selected?.color && <i className="ctx-menu-dot" style={{ background: selected.color }} />}<span className="app-select-label">{selected?.label}</span>
      <svg className="app-select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {shown && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={ariaLabel} className="app-context-menu app-select-menu" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAndFocus(); }
      if (event.key === "Tab") { closeAndFocus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        const button = buttons[next];
        button?.focus({ preventScroll: true });
        const element = menu.current;
        if (button && element) {
          if (button.offsetTop < element.scrollTop) element.scrollTop = button.offsetTop;
          else if (button.offsetTop + button.offsetHeight > element.scrollTop + element.clientHeight) element.scrollTop = button.offsetTop + button.offsetHeight - element.clientHeight;
        }
      }
    }}>{options.map(option => <button type="button" role="menuitemradio" aria-checked={value === option.value} key={option.value ?? "ungrouped"} className="ctx-menu-item" title={option.label}
      onClick={() => { closeAndFocus(); if (option.value !== value) onChange(option.value); }}>
      {option.color && <i className="ctx-menu-dot" style={{ background: option.color }} />}<span className="app-select-label">{option.label}</span><svg className="app-select-check" viewBox="0 0 16 16" aria-hidden="true" style={{ visibility: value === option.value ? "visible" : "hidden" }}><path d="m3 8 3 3 7-7" /></svg>
    </button>)}</div>, document.body)}
  </>;
}
