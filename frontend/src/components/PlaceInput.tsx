import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Loader2, MapPin, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../api/client";
import type { Place } from "../api/types";
import { useDebounced } from "../hooks/useDebounced";

export type PlaceValue = Place | string;

export const placeText = (v: PlaceValue) => (typeof v === "string" ? v : v.label);

interface Props {
  label: string;
  value: PlaceValue;
  onChange: (v: PlaceValue) => void;
  placeholder?: string;
  error?: string;
  icon?: ReactNode;
}

export function PlaceInput({ label, value, onChange, placeholder, error, icon }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const text = placeText(value);
  const picked = typeof value !== "string";
  const q = useDebounced(picked ? "" : text.trim(), 250);

  const {
    data: results = [],
    isFetching,
    isError,
  } = useQuery({
    queryKey: ["geocode", q],
    queryFn: ({ signal }) => api.geocode(q, signal),
    enabled: q.length >= 2,
    staleTime: 60 * 60_000,
  });
  const showList = open && !picked && q.length >= 2 && (results.length > 0 || (!isFetching && !isError));

  const choose = (p: Place) => {
    onChange(p);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && showList && active >= 0 && results[active]) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-400">
          {icon ?? <MapPin size={16} />}
        </span>
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${id}-opt-${active}` : undefined}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          autoComplete="off"
          spellCheck={false}
          className={clsx("field pr-9 pl-9", error && "field-invalid", picked && "text-ink-100")}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => {
            clearTimeout(blurTimer.current); // refocused (e.g. after Clear): keep suggestions open
            setOpen(true);
          }}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="absolute top-1/2 right-2 -translate-y-1/2">
          {isFetching ? (
            <Loader2 size={16} className="animate-spin text-ink-400" aria-label="Searching" />
          ) : text ? (
            <button
              type="button"
              className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
              aria-label={`Clear ${label.toLowerCase()}`}
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          ) : null}
        </span>
      </div>
      {error && (
        <p id={`${id}-err`} className="mt-1 text-xs text-risk-severe">
          {error}
        </p>
      )}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="panel scroll-thin absolute z-30 mt-1 max-h-64 w-full overflow-auto py-1"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-400">No places found. Try a city and state.</li>
          ) : (
            results.map((p, i) => (
              <li
                key={`${p.label}-${p.lat}-${p.lon}`}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={clsx(
                  "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                  i === active ? "bg-ink-700 text-white" : "text-ink-200 hover:bg-ink-800",
                )}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(p)}
              >
                <MapPin size={14} className="shrink-0 text-ink-400" />
                <span className="truncate">{p.label}</span>
                {p.kind && <span className="ml-auto text-[10px] text-ink-400 uppercase">{p.kind}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
