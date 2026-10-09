import { useEffect, useId, useRef, useState } from "react";

interface Props {
  value: string[];
  options: { value: string; label: string }[];
  onChange: (value: string[]) => void;
  label: string;
  placeholder: string;
  disabled?: boolean;
}

export default function IosMultiSelect({ value, options, onChange, label, placeholder, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [openAbove, setOpenAbove] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const selected = options.filter((option) => value.includes(option.value));
  const summary = selected.length ? selected.map((option) => option.label).join("、") : placeholder;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className={`ios-select cleanup-category-select${openAbove ? " open-above" : ""}`} ref={ref} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
        className={`ios-select-trigger${open ? " open" : ""}`}
        type="button"
        disabled={disabled}
        aria-label={`${label}: ${summary}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const bounds = triggerRef.current?.getBoundingClientRect();
          if (bounds) {
            const below = window.innerHeight - bounds.bottom;
            setOpenAbove(below < 284 && bounds.top > below);
          }
          setOpen(!open);
        }}
      >
        <span className="ios-select-value">{summary}</span>
        <span className={`ios-select-arrow${open ? " open" : ""}`} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="ios-select-dropdown" id={panelId} role="group" aria-label={label}>
          <div className="ios-select-dropdown-inner">
            {options.map((option) => (
              <label key={option.value} className="cleanup-category-option">
                <input
                  type="checkbox"
                  checked={value.includes(option.value)}
                  disabled={disabled}
                  onChange={(event) => onChange(event.target.checked
                    ? [...value, option.value]
                    : value.filter((category) => category !== option.value))}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
