/**
 * postMessage contract between the /embed iframe and the /widget.js loader.
 * The loader inlines the same literal (it is a plain-JS string template), so
 * keep both in sync (`tests/api/widget-loader.test.ts` pins the loader to it).
 */
export const WIDGET_CLOSE_MESSAGE = "hvac-widget:close";
