/* =========================================================================
   HAR SANITIZER  —  run as an Edge DevTools Snippet (Windows-friendly)

   No Python, no installs. Opens a file picker, sanitizes the HAR entirely
   in-browser, and downloads the cleaned copy. Nothing is uploaded anywhere.

   USAGE
     1. Sources -> Snippets -> New snippet -> paste this -> Ctrl+S
     2. Ctrl+Enter to run
     3. Pick your .har file when the picker opens
     4. Sanitized copy lands in your Downloads folder

   OPTIONS: edit CFG below before running.
   ========================================================================= */

const CFG = {
  apiOnly: true,        // keep only /api/ and getfile entries
  maxString: 300,       // truncate longer string values
  scrubFilenames: false // true = also pseudonymize *.pdf names
};

(() => {
  const SENSITIVE_HEADERS = new Set([
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "api-key", "x-auth-token", "x-access-token", "x-csrf-token",
    "x-xsrf-token", "x-session-token", "x-amz-security-token", "authentication"
  ]);

  const SENSITIVE_QUERY = new Set([
    "token", "access_token", "id_token", "refresh_token", "code", "sig",
    "signature", "key", "apikey", "api_key", "password", "secret", "auth",
    "x-amz-signature", "x-amz-credential", "sas", "se", "sp", "sv"
  ]);

  const DROP_MIME_PREFIX = ["image/", "video/", "audio/", "font/"];
  const DROP_MIME_EXACT = new Set([
    "application/pdf", "application/octet-stream", "application/zip",
    "application/x-protobuf", "application/msword"
  ]);

  const PAT = {
    JWT:   /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g,
    UUID:  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    HASH:  /\b[0-9a-fA-F]{24,}\b/g,
    EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    IP:    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    PDF:   /\b[\w\-. ]+\.pdf\b/gi
  };

  // ---- stable value -> placeholder vault --------------------------------
  const vault = {};
  const counts = {};
  function tok(kind, value) {
    vault[kind] ||= new Map();
    if (!vault[kind].has(value)) {
      vault[kind].set(value, `<<${kind}_${vault[kind].size + 1}>>`);
    }
    counts[kind] = (counts[kind] || 0) + 1;
    return vault[kind].get(value);
  }

  function scrubText(s) {
    if (typeof s !== "string" || !s) return s;
    s = s.replace(PAT.JWT,   m => tok("JWT", m));
    s = s.replace(PAT.UUID,  m => tok("UUID", m));
    s = s.replace(PAT.HASH,  m => tok("HASH", m));
    s = s.replace(PAT.EMAIL, m => tok("EMAIL", m));
    s = s.replace(PAT.IP,    m => tok("IP", m));
    if (CFG.scrubFilenames) s = s.replace(PAT.PDF, m => tok("FILE", m) + ".pdf");
    return s;
  }

  function scrubUrl(url) {
    const m = /^(https?:\/\/)([^/]+)(.*)$/.exec(url || "");
    if (!m) return scrubText(url);
    const [, scheme, host, rest] = m;
    const hostTok = tok("HOST", host);
    if (!rest.includes("?")) return scheme + hostTok + scrubText(rest);
    const [path, query] = rest.split(/\?(.*)/s);
    const q = query.split("&").map(kv => {
      const i = kv.indexOf("=");
      if (i < 0) return kv;
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      return SENSITIVE_QUERY.has(k.toLowerCase())
        ? `${k}=<<REDACTED>>`
        : `${k}=${scrubText(v)}`;
    }).join("&");
    return scheme + hostTok + scrubText(path) + "?" + q;
  }

  function scrubHeaders(hs) {
    return (hs || []).map(h =>
      SENSITIVE_HEADERS.has((h.name || "").toLowerCase())
        ? { name: h.name, value: `<<REDACTED_${(h.name || "").toUpperCase()}>>` }
        : { name: h.name, value: scrubText(h.value || "") }
    );
  }

  function scrubJson(o) {
    if (Array.isArray(o)) return o.map(scrubJson);
    if (o && typeof o === "object") {
      const out = {};
      for (const k of Object.keys(o)) out[k] = scrubJson(o[k]);
      return out;
    }
    if (typeof o === "string") {
      const s = scrubText(o);
      return s.length > CFG.maxString
        ? s.slice(0, CFG.maxString) + `…<<TRUNCATED len=${o.length}>>`
        : s;
    }
    return o;
  }

  function scrubBody(c) {
    if (!c) return;
    const mime = (c.mimeType || "").split(";")[0].trim().toLowerCase();
    if (DROP_MIME_PREFIX.some(p => mime.startsWith(p)) || DROP_MIME_EXACT.has(mime)) {
      const size = c.size ?? (c.text ? c.text.length : 0);
      delete c.text; delete c.params;
      c.comment = `<<BINARY DROPPED mime=${mime} size=${size}>>`;
      return;
    }
    if (c.encoding === "base64") {
      delete c.text;
      c.comment = "<<BASE64 DROPPED>>";
      return;
    }
    if (c.text) {
      try {
        c.text = JSON.stringify(scrubJson(JSON.parse(c.text)), null, 1);
      } catch {
        let s = scrubText(c.text);
        const cap = CFG.maxString * 6;
        if (s.length > cap) s = s.slice(0, cap) + `…<<TRUNCATED len=${c.text.length}>>`;
        c.text = s;
      }
    }
    if (c.params) {
      for (const p of c.params) {
        p.value = SENSITIVE_QUERY.has((p.name || "").toLowerCase())
          ? "<<REDACTED>>" : scrubText(p.value || "");
      }
    }
  }

  // ---- file picker -------------------------------------------------------
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".har,application/json";
  input.style.cssText =
    "position:fixed;z-index:2147483647;top:14px;left:50%;transform:translateX(-50%);" +
    "padding:14px 18px;background:#111;color:#fff;border:2px solid #0af;" +
    "border-radius:8px;font:14px system-ui";
  document.body.appendChild(input);
  console.log("%c[har] Pick your .har file (button at top of the page).",
              "color:#0af;font-weight:bold");

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    input.remove();
    console.log(`[har] reading ${file.name} (${(file.size / 1e6).toFixed(2)} MB)…`);

    let har;
    try {
      har = JSON.parse(await file.text());
    } catch (e) {
      console.error("[har] not valid JSON — was it saved as a .har?", e);
      return;
    }

    const all = har?.log?.entries || [];
    const kept = [];

    for (const e of all) {
      const url = e?.request?.url || "";
      if (CFG.apiOnly && !/\/api\/|getfile/i.test(url)) continue;

      const req = e.request || {}, res = e.response || {};
      req.url = scrubUrl(url);
      req.headers = scrubHeaders(req.headers);
      req.cookies = [];
      for (const q of req.queryString || []) {
        q.value = SENSITIVE_QUERY.has((q.name || "").toLowerCase())
          ? "<<REDACTED>>" : scrubText(q.value || "");
      }
      scrubBody(req.postData);

      res.headers = scrubHeaders(res.headers);
      res.cookies = [];
      if (res.redirectURL) res.redirectURL = scrubUrl(res.redirectURL);
      scrubBody(res.content);

      delete e.serverIPAddress;
      delete e.connection;
      if (e._initiator && typeof e._initiator === "object") {
        e._initiator = { type: e._initiator.type || "?" };
      }
      kept.push(e);
    }

    har.log.entries = kept;
    for (const p of har.log.pages || []) p.title = scrubUrl(p.title || "");

    const out = JSON.stringify(har, null, 1);

    // ---- report ----------------------------------------------------------
    console.log(`[har] entries ${all.length} -> ${kept.length}`);
    console.log(`[har] size ${(file.size / 1e6).toFixed(2)} MB -> ${(out.length / 1e6).toFixed(2)} MB`);
    console.table(
      Object.keys(vault).map(k => ({
        kind: k, distinct: vault[k].size, occurrences: counts[k] || 0
      }))
    );

    const problems = [];
    if (new RegExp(PAT.JWT.source).test(out)) problems.push("possible JWT remains");
    if (/"value"\s*:\s*"Bearer\s+\S/.test(out)) problems.push("literal Bearer value remains");
    if (new RegExp(PAT.EMAIL.source).test(out)) problems.push("email address remains");
    for (const kw of ["password", "client_secret", "private_key"]) {
      if (new RegExp(`"${kw}"\\s*:\\s*"[^"<]`).test(out)) problems.push(`${kw} literal remains`);
    }
    if (problems.length) {
      console.warn("[har] LEAK CHECK:", problems);
      console.warn("[har] Inspect the output before sharing it.");
    } else {
      console.log("%c[har] leak check: no known secret patterns detected", "color:#0a0");
    }

    // ---- download --------------------------------------------------------
    const blob = new Blob([out], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name.replace(/\.har$/i, "") + ".sanitized.har";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    console.log("%c[har] done — check your Downloads folder.",
                "color:#0af;font-weight:bold");
  });
})();
