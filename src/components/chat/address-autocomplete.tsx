'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MapPin } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  fetchAddressSuggestions,
  haversineKm,
  type AddressSuggestion,
} from '@/lib/address/photon';
import { BUSINESS_BASE_LOCATION } from '@/lib/config/business-location';

interface AddressAutocompleteProps {
  readonly onSelect: (fullAddress: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

const DEBOUNCE_MS = 250;
const LISTBOX_ID = 'address-autocomplete-listbox';
const optionId = (index: number) => `address-autocomplete-option-${index}`;
const KM_TO_MILES = 0.621371;

/**
 * Display-only "~N mi" hint for a suggestion's distance from the business base.
 * Returns null when the suggestion has no coordinates. This never affects the
 * string passed to onSelect.
 */
function distanceHint(suggestion: AddressSuggestion): string | null {
  if (typeof suggestion.lat !== 'number' || typeof suggestion.lon !== 'number') {
    return null;
  }
  const km = haversineKm(
    BUSINESS_BASE_LOCATION.latitude,
    BUSINESS_BASE_LOCATION.longitude,
    suggestion.lat,
    suggestion.lon,
  );
  return `~${Math.round(km * KM_TO_MILES)} mi`;
}

/**
 * Keyless address autocomplete for the chat's service-address step.
 *
 * The parent (chat-experience.tsx) should render this in place of the normal
 * text input ONLY while the pending conversation step is the service-address
 * step. When the customer picks a suggestion, `onSelect(fullAddress)` fires with
 * a full, ZIP-bearing address string — the parent should send that string as the
 * customer's chat message exactly as if they had typed it. If Photon returns
 * nothing (or is unreachable), the dropdown simply never appears and the customer
 * types/submits free-form via the parent's normal send path; the existing
 * "what city and ZIP?" follow-up handles partial addresses. This component owns
 * no submit button — selection is the only "send" trigger it produces.
 */
export function AddressAutocomplete({
  onSelect,
  disabled = false,
  placeholder = 'Start typing your service address...',
}: AddressAutocompleteProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<readonly AddressSuggestion[]>(
    [],
  );
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      abortRef.current?.abort();
      setSuggestions([]);
      setOpen(false);
      setHighlighted(-1);
      return;
    }

    const timer = setTimeout(() => {
      // Abort any in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      fetchAddressSuggestions(trimmed, {
        signal: controller.signal,
        near: {
          lat: BUSINESS_BASE_LOCATION.latitude,
          lon: BUSINESS_BASE_LOCATION.longitude,
        },
      })
        .then((results) => {
          if (controller.signal.aborted) return;
          setSuggestions(results);
          setOpen(results.length > 0);
          setHighlighted(results.length > 0 ? 0 : -1);
        })
        .catch(() => {
          // fetchAddressSuggestions never throws, but stay defensive.
          if (controller.signal.aborted) return;
          setSuggestions([]);
          setOpen(false);
          setHighlighted(-1);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  // Clean up any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  function choose(suggestion: AddressSuggestion) {
    onSelect(suggestion.label);
    setQuery('');
    setSuggestions([]);
    setOpen(false);
    setHighlighted(-1);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      setHighlighted(-1);
      return;
    }

    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      if (highlighted >= 0 && highlighted < suggestions.length) {
        e.preventDefault();
        choose(suggestions[highlighted]);
      }
    }
  }

  const showDropdown = open && suggestions.length > 0;

  return (
    <div className="relative border-t bg-background p-3">
      <div className="relative">
        <MapPin className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus
          className="pl-8"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            showDropdown && highlighted >= 0 ? optionId(highlighted) : undefined
          }
          aria-label="Service address"
        />
      </div>

      {showDropdown && (
        <ul
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Address suggestions"
          className="absolute bottom-full left-3 right-3 z-10 mb-1 max-h-60 overflow-auto rounded-lg border border-border bg-background py-1 shadow-md"
        >
          {suggestions.map((s, i) => {
            const hint = distanceHint(s);
            return (
              <li
                key={`${s.label}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === highlighted}
                onMouseDown={(e) => {
                  // Prevent the input blur from closing the list before click.
                  e.preventDefault();
                  choose(s);
                }}
                onMouseEnter={() => setHighlighted(i)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${
                  i === highlighted
                    ? 'bg-muted text-foreground'
                    : 'text-foreground'
                }`}
              >
                <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{s.label}</span>
                {hint !== null && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {hint}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
