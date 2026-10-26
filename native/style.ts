// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, scroll bars) fall back to.
// The browser build's body class for high contrast (its own toggle, now the
// runtime's accessibility option) is a token set here.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
const HIGH_CONTRAST: Tokens = {
  scrim: "rgba(4, 19, 27, 0.95)", btn: "rgba(79, 216, 194, 0.22)", "btn-line": "#9bf6e4", ink: "#ffffff",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: "#eafcff", muted: "#b8d4da", panel: "#04131b", control: "#0b2a33", hovered: "#12414a",
    pressed: "#12414a", field: "#0b2a33", accent: "#4fd8c2", focus: "#9bf6e4", outline: "#000000",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 40,
      parts: { box: { background: "#0b2a33", border: { width: 1, color: "$btn-line" }, radius: 4 }, mark: { background: "$accent" } },
    },
    scrollArea: { parts: { bar: { background: "$btn-line", radius: 4 } } },
  });
}

let paletteKey = "";
/** The palette tokens: high contrast (denser scrims, brighter borders and ink) over the sheet's. */
export function applyPalette(highContrast: boolean): void {
  const key = String(highContrast);
  if (key === paletteKey) return;
  paletteKey = key;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
