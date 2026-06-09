import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { searchPhoton, type GeoResult } from "./geocode";

/**
 * Debounced OSM (Photon) place search with keyboard nav. On select it fills the
 * input and closes the list. Lives in its own module so react-refresh treats it
 * as a clean boundary (an in-file forward reference from InfoPanel tripped
 * "PlaceSearch is not defined" during HMR).
 */
export const PlaceSearch = forwardRef<HTMLInputElement, { onPick: (r: GeoResult) => void }>(
  function PlaceSearch({ onPick }, ref) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // Expose the input so a global "/" shortcut can focus it from App.
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);
  // Set when we fill the input from a selection, so the debounce effect below
  // doesn't re-search and reopen the dropdown after the user has picked.
  const skipSearch = useRef(false);

  const clear = () => {
    setQ("");
    setResults([]);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  };

  // Photon's free endpoint discourages a per-keystroke storm: wait 350ms after
  // typing stops and require >=3 chars.
  useEffect(() => {
    if (skipSearch.current) {
      skipSearch.current = false;
      return;
    }
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      searchPhoton(q, ac.signal)
        .then((r) => {
          setResults(r);
          setActive(-1);
          setOpen(true);
        })
        .catch((err) => {
          if (err.name !== "AbortError") console.warn("[geocode]", err);
        })
        .finally(() => setBusy(false));
    }, 350);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  const choose = (r: GeoResult) => {
    onPick(r);
    skipSearch.current = true;
    setQ(r.label);
    setResults([]);
    setOpen(false);
    setActive(-1);
    // Release focus so map keyboard shortcuts (M, L, D…) work immediately
    // without a click. `/` refocuses the box to edit again.
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open && results.length > 0) setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = active >= 0 ? results[active] : results[0];
      if (pick) choose(pick);
    } else if (e.key === "Escape") {
      // First Esc on an open dropdown just dismisses it; a second Esc (or Esc
      // on a filled box) clears the text. Then release focus.
      if (open && results.length > 0) {
        setOpen(false);
      } else {
        skipSearch.current = true;
        setQ("");
        setResults([]);
        setActive(-1);
      }
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div style={{ position: "relative", marginTop: 8 }}>
      <input
        ref={inputRef}
        type="text"
        value={q}
        placeholder="search a place…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "5px 24px 5px 8px",
          fontSize: 12,
          borderRadius: 4,
          border: "1px solid rgba(255,255,255,0.25)",
          background: "rgba(255,255,255,0.1)",
          color: "white",
          outline: "none",
        }}
      />
      {/* Spinner sits left of the × so an in-flight search never hides the
          clear control — you can always bail out of a filled box. */}
      {busy && (
        <span style={{ position: "absolute", right: 26, top: 6, fontSize: 10, opacity: 0.5 }}>
          …
        </span>
      )}
      {q.length > 0 && (
        <button
          type="button"
          aria-label="clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          style={{
            position: "absolute",
            right: 4,
            top: 3,
            width: 18,
            height: 18,
            padding: 0,
            lineHeight: "16px",
            fontSize: 13,
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.55)",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      )}
      {open && results.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: "2px 0 0 0",
            padding: 0,
            position: "absolute",
            zIndex: 10,
            width: "100%",
            maxHeight: 220,
            overflow: "auto",
            background: "rgba(20,20,20,0.97)",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          {results.map((r, i) => (
            <li key={`${r.label}-${i}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r)}
                onMouseEnter={() => setActive(i)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  fontSize: 11,
                  background: i === active ? "rgba(255,255,255,0.15)" : "transparent",
                  border: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  },
);
