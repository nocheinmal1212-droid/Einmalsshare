#!/usr/bin/env python3
"""
HAR sanitizer.

Produces a full, structurally intact HAR with every credential and identifying
value replaced by a STABLE placeholder. Equal values map to equal placeholders,
so relationships between requests survive (e.g. an ID issued in one response and
consumed in a later URL still visibly matches) without exposing the real value.

Removed outright:
  - Authorization / Cookie / Set-Cookie / API-key header values
  - Cookie objects, IP addresses, binary + PDF payloads
Pseudonymized (stable, reversible only by you):
  - Hostnames, JWTs, UUIDs, long hex hashes, emails, bearer-ish opaque strings
Preserved:
  - Methods, URL paths, query parameter NAMES, status codes, timings
  - All header names, all JSON keys and structure
  - Short scalar values (numbers, enums, flags, short strings)

Usage:
    python3 har-sanitize.py <input.har> [options]

Options:
    --api-only          keep only entries whose path contains /api/ or getfile
    --max-string N      truncate string values longer than N chars (default 300)
    --scrub-filenames   also pseudonymize *.pdf filenames
    --out PATH          output path (default: <input>.sanitized.har)
"""

import json
import re
import sys
from collections import OrderedDict

# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #

SENSITIVE_HEADERS = {
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "api-key", "x-auth-token", "x-access-token", "x-csrf-token",
    "x-xsrf-token", "x-session-token", "x-amz-security-token", "authentication",
}

SENSITIVE_QUERY_KEYS = {
    "token", "access_token", "id_token", "refresh_token", "code", "sig",
    "signature", "key", "apikey", "api_key", "password", "secret", "auth",
    "x-amz-signature", "x-amz-credential", "sas", "se", "sp", "sv",
}

DROP_MIME_PREFIXES = ("image/", "video/", "audio/", "font/")
DROP_MIME_EXACT = {
    "application/pdf", "application/octet-stream", "application/zip",
    "application/x-protobuf", "application/msword",
}

PAT_JWT = re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}(?:\.[A-Za-z0-9_\-]+)?")
PAT_UUID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
PAT_HEXHASH = re.compile(r"\b[0-9a-fA-F]{24,}\b")
PAT_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
PAT_PDFNAME = re.compile(r"\b[\w\-. ]+\.pdf\b", re.I)
PAT_IPV4 = re.compile(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")


class Vault:
    """Stable value -> placeholder mapping."""

    def __init__(self):
        self.maps = {}
        self.counts = {}

    def token(self, kind, value):
        bucket = self.maps.setdefault(kind, OrderedDict())
        if value not in bucket:
            bucket[value] = f"<<{kind}_{len(bucket) + 1}>>"
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return bucket[value]

    def summary(self):
        return {k: (len(v), self.counts.get(k, 0)) for k, v in self.maps.items()}


VAULT = Vault()


# --------------------------------------------------------------------------- #
# scrubbing primitives
# --------------------------------------------------------------------------- #

def scrub_text(s, scrub_filenames=False):
    """Apply all pattern-based pseudonymization to a string."""
    if not isinstance(s, str) or not s:
        return s
    s = PAT_JWT.sub(lambda m: VAULT.token("JWT", m.group(0)), s)
    s = PAT_UUID.sub(lambda m: VAULT.token("UUID", m.group(0)), s)
    s = PAT_HEXHASH.sub(lambda m: VAULT.token("HASH", m.group(0)), s)
    s = PAT_EMAIL.sub(lambda m: VAULT.token("EMAIL", m.group(0)), s)
    s = PAT_IPV4.sub(lambda m: VAULT.token("IP", m.group(0)), s)
    if scrub_filenames:
        s = PAT_PDFNAME.sub(lambda m: VAULT.token("FILE", m.group(0)) + ".pdf", s)
    return s


def scrub_url(url, scrub_filenames=False):
    """Pseudonymize host, redact sensitive query values, keep path shape."""
    m = re.match(r"(https?://)([^/]+)(.*)", url)
    if not m:
        return scrub_text(url, scrub_filenames)
    scheme, host, rest = m.groups()
    host_tok = VAULT.token("HOST", host)

    if "?" in rest:
        path, query = rest.split("?", 1)
        parts = []
        for kv in query.split("&"):
            if "=" in kv:
                k, v = kv.split("=", 1)
                if k.lower() in SENSITIVE_QUERY_KEYS:
                    parts.append(f"{k}=<<REDACTED>>")
                else:
                    parts.append(f"{k}={scrub_text(v, scrub_filenames)}")
            else:
                parts.append(kv)
        rest = path + "?" + "&".join(parts)
        rest = scrub_text(rest, scrub_filenames) if False else rest
        path_scrubbed = scrub_text(path, scrub_filenames)
        rest = path_scrubbed + "?" + "&".join(parts)
    else:
        rest = scrub_text(rest, scrub_filenames)

    return f"{scheme}{host_tok}{rest}"


def scrub_headers(headers, scrub_filenames=False):
    out = []
    for h in headers or []:
        name = h.get("name", "")
        if name.lower() in SENSITIVE_HEADERS:
            out.append({"name": name, "value": f"<<REDACTED_{name.upper()}>>"})
        else:
            out.append({
                "name": name,
                "value": scrub_text(h.get("value", ""), scrub_filenames),
            })
    return out


def scrub_json(obj, max_string, scrub_filenames=False, depth=0):
    """Recursively scrub a parsed JSON structure, preserving keys and shape."""
    if isinstance(obj, dict):
        return {k: scrub_json(v, max_string, scrub_filenames, depth + 1)
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub_json(v, max_string, scrub_filenames, depth + 1) for v in obj]
    if isinstance(obj, str):
        s = scrub_text(obj, scrub_filenames)
        if len(s) > max_string:
            return s[:max_string] + f"…<<TRUNCATED len={len(obj)}>>"
        return s
    return obj


def scrub_body(container, max_string, scrub_filenames=False):
    """Scrub request.postData or response.content in place."""
    if not container:
        return
    mime = (container.get("mimeType") or "").split(";")[0].strip().lower()

    if mime.startswith(DROP_MIME_PREFIXES) or mime in DROP_MIME_EXACT:
        size = container.get("size", len(container.get("text", "") or ""))
        container.pop("text", None)
        container.pop("params", None)
        container["comment"] = f"<<BINARY DROPPED mime={mime} size={size}>>"
        return

    if container.get("encoding") == "base64":
        container.pop("text", None)
        container["comment"] = "<<BASE64 DROPPED>>"
        return

    txt = container.get("text")
    if txt:
        try:
            parsed = json.loads(txt)
            container["text"] = json.dumps(
                scrub_json(parsed, max_string, scrub_filenames), indent=1
            )
        except Exception:
            s = scrub_text(txt, scrub_filenames)
            if len(s) > max_string * 6:
                s = s[: max_string * 6] + f"…<<TRUNCATED len={len(txt)}>>"
            container["text"] = s

    if container.get("params"):
        for p in container["params"]:
            if p.get("name", "").lower() in SENSITIVE_QUERY_KEYS:
                p["value"] = "<<REDACTED>>"
            else:
                p["value"] = scrub_text(p.get("value", ""), scrub_filenames)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    src = args[0]
    api_only = "--api-only" in args
    scrub_filenames = "--scrub-filenames" in args
    max_string = 300
    if "--max-string" in args:
        max_string = int(args[args.index("--max-string") + 1])
    out_path = (
        args[args.index("--out") + 1]
        if "--out" in args
        else re.sub(r"\.har$", "", src) + ".sanitized.har"
    )

    with open(src, "r", encoding="utf-8") as f:
        har = json.load(f)

    entries = har.get("log", {}).get("entries", [])
    kept = []

    for e in entries:
        url = e.get("request", {}).get("url", "")
        if api_only and not re.search(r"/api/|getfile", url, re.I):
            continue

        req = e.get("request", {})
        res = e.get("response", {})

        req["url"] = scrub_url(url, scrub_filenames)
        req["headers"] = scrub_headers(req.get("headers"), scrub_filenames)
        req["cookies"] = []
        for q in req.get("queryString", []) or []:
            if q.get("name", "").lower() in SENSITIVE_QUERY_KEYS:
                q["value"] = "<<REDACTED>>"
            else:
                q["value"] = scrub_text(q.get("value", ""), scrub_filenames)
        scrub_body(req.get("postData"), max_string, scrub_filenames)

        res["headers"] = scrub_headers(res.get("headers"), scrub_filenames)
        res["cookies"] = []
        if res.get("redirectURL"):
            res["redirectURL"] = scrub_url(res["redirectURL"], scrub_filenames)
        scrub_body(res.get("content"), max_string, scrub_filenames)

        e.pop("serverIPAddress", None)
        e.pop("connection", None)
        if isinstance(e.get("_initiator"), dict):
            e["_initiator"] = {"type": e["_initiator"].get("type", "?")}

        kept.append(e)

    har["log"]["entries"] = kept
    for p in har["log"].get("pages", []) or []:
        p["title"] = scrub_url(p.get("title", ""), scrub_filenames)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(har, f, indent=1)

    # ---------------------------------------------------------------- report
    import os
    print(f"\nwrote: {out_path}")
    print(f"entries: {len(entries)} -> {len(kept)}")
    print(f"size:    {os.path.getsize(src) / 1e6:.2f} MB -> "
          f"{os.path.getsize(out_path) / 1e6:.2f} MB")

    print("\npseudonymized (distinct values / total occurrences):")
    for kind, (n_distinct, n_total) in sorted(VAULT.summary().items()):
        print(f"  {kind:6}  {n_distinct:4} distinct   {n_total:5} occurrences")

    # -------------------------------------------------- post-scrub leak check
    print("\nleak check on output:")
    with open(out_path, "r", encoding="utf-8") as f:
        blob = f.read()
    problems = []
    if PAT_JWT.search(blob):
        problems.append("possible JWT remains")
    if re.search(r'"value"\s*:\s*"Bearer\s+\S', blob):
        problems.append("literal Bearer value remains")
    if PAT_EMAIL.search(blob):
        problems.append("email address remains")
    for kw in ("password", "client_secret", "private_key"):
        if re.search(rf'"{kw}"\s*:\s*"[^"<]', blob):
            problems.append(f"{kw} with a literal value remains")
    if problems:
        print("  ⚠  " + "\n  ⚠  ".join(problems))
        print("  Inspect the output before sharing it.")
    else:
        print("  no known secret patterns detected")

    print("\nOpen the output and skim it before sending. Automated redaction is")
    print("best-effort; you own the final call on whether it can leave the device.")


if __name__ == "__main__":
    main()
