/**
 * The widget embed snippet. Publishable keys are stored hashed, so the full
 * key exists in the browser only right after it is created. The snippet uses
 * that full key when we have it; otherwise it shows a placeholder and must not
 * be copied (a truncated "pk_live_1234…" key silently breaks the widget).
 */
export const WIDGET_SCRIPT_URL = 'https://ai-hvac-agent-lovat.vercel.app/widget.js';
export const KEY_PLACEHOLDER = 'YOUR_PUBLISHABLE_KEY';

export interface EmbedSnippet {
  readonly text: string;
  /** False while the snippet holds the placeholder instead of a real key. */
  readonly copyable: boolean;
}

export function buildEmbedSnippet(fullPublishableKey: string | null): EmbedSnippet {
  const key = fullPublishableKey?.trim() || null;
  const usable = key !== null && !key.includes('…');
  return {
    text: `<script src="${WIDGET_SCRIPT_URL}"\n        data-hvac-key="${usable ? key : KEY_PLACEHOLDER}" async></script>`,
    copyable: usable,
  };
}
