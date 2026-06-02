import { NextRequest, NextResponse } from "next/server";

/**
 * The embeddable widget loader. A contractor pastes:
 *
 *   <script src="https://<app>/widget.js" data-hvac-key="pk_live_…" async></script>
 *
 * This route returns a small vanilla-JS IIFE that:
 *   1. reads the publishable key from the script tag's data-hvac-key,
 *   2. fetches PUBLIC branding from /api/widget/config (cached in localStorage),
 *   3. paints a Shadow-DOM launcher bubble (style-isolated from the host page),
 *   4. lazily mounts an <iframe> to /embed?key=… on first open.
 *
 * The heavy React chat UI lives in the iframe (same-origin with our API); the
 * host page only ever runs this tiny isolated launcher.
 */

function buildLoader(appOrigin: string): string {
  return `(function () {
  "use strict";
  var APP = ${JSON.stringify(appOrigin)};
  var current = document.currentScript;
  var KEY = current && current.getAttribute("data-hvac-key");
  if (!KEY) {
    console.error("[hvac-widget] missing data-hvac-key on the script tag");
    return;
  }
  if (window.__hvacWidgetLoaded) return;
  window.__hvacWidgetLoaded = true;

  var CACHE_KEY = "hvac_widget_cfg_" + KEY;
  var DEFAULTS = {
    primaryColor: "#2563eb",
    companyName: "Chat with us",
    welcomeMessage: "",
    launcherPosition: "bottom-right",
    logoUrl: null
  };

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.expires > Date.now()) return parsed.data;
    } catch (e) {}
    return null;
  }
  function writeCache(data) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ data: data, expires: Date.now() + 3600000 })
      );
    } catch (e) {}
  }

  function fetchConfig() {
    var cached = readCache();
    if (cached) return Promise.resolve(cached);
    return fetch(APP + "/api/widget/config?key=" + encodeURIComponent(KEY))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        var cfg = body && body.success ? body.data.config : null;
        if (cfg) writeCache(cfg);
        return cfg;
      })
      .catch(function () { return null; });
  }

  function mount(cfg) {
    var c = {};
    for (var k in DEFAULTS) c[k] = DEFAULTS[k];
    if (cfg) for (var k2 in cfg) if (cfg[k2] != null) c[k2] = cfg[k2];

    var host = document.createElement("div");
    host.setAttribute("data-hvac-widget", "");
    document.body.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;

    var side = c.launcherPosition === "bottom-left" ? "left" : "right";
    var style = document.createElement("style");
    style.textContent = [
      ":host{all:initial}",
      ".w-wrap{position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;font-family:system-ui,-apple-system,sans-serif}",
      ".w-btn{width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;transition:transform .15s ease;color:#fff}",
      ".w-btn:hover{transform:scale(1.06)}",
      ".w-btn svg{width:28px;height:28px}",
      ".w-panel{position:fixed;bottom:92px;" + side + ":20px;width:380px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 120px);border-radius:16px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.24);background:#fff;border:1px solid rgba(0,0,0,.08);opacity:0;transform:translateY(12px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}",
      ".w-panel.open{opacity:1;transform:translateY(0);pointer-events:auto}",
      ".w-panel iframe{width:100%;height:100%;border:0;display:block}",
      "@media (max-width:480px){.w-panel{width:100vw;max-width:100vw;height:100vh;max-height:100vh;bottom:0;" + side + ":0;border-radius:0}}"
    ].join("");
    root.appendChild(style);

    var wrap = document.createElement("div");
    wrap.className = "w-wrap";

    var panel = document.createElement("div");
    panel.className = "w-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", c.companyName || "Chat");

    var btn = document.createElement("button");
    btn.className = "w-btn";
    btn.style.background = c.primaryColor;
    btn.setAttribute("aria-label", "Open chat");
    btn.setAttribute("aria-expanded", "false");
    var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    btn.innerHTML = ICON_CHAT;

    var iframe = null;
    var open = false;

    function ensureIframe() {
      if (iframe) return;
      iframe = document.createElement("iframe");
      iframe.title = "Chat";
      iframe.setAttribute("allow", "clipboard-write");
      iframe.src = APP + "/embed?key=" + encodeURIComponent(KEY);
      panel.appendChild(iframe);
    }

    function setOpen(next) {
      open = next;
      if (open) ensureIframe();
      panel.classList.toggle("open", open);
      btn.innerHTML = open ? ICON_CLOSE : ICON_CHAT;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    }

    btn.addEventListener("click", function () { setOpen(!open); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open) setOpen(false);
    });

    wrap.appendChild(panel);
    wrap.appendChild(btn);
    root.appendChild(wrap);
  }

  function start() { fetchConfig().then(mount); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();`;
}

export function GET(request: NextRequest) {
  // Serve the loader from the request's own origin so the iframe/config calls
  // are same-origin with this deployment.
  const appOrigin = request.nextUrl.origin;
  return new NextResponse(buildLoader(appOrigin), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Cache at the edge but allow quick iteration.
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
