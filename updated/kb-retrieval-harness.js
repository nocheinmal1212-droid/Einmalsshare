(() => {
  "use strict";

  /*
   * KB Full Retrieval browser-console harness
   *
   * Run this as an Edge DevTools Snippet on the authenticated application page.
   * It intentionally uses only browser APIs and stores no Bearer-token value.
   */

  const VERSION = "1.2.0";

  // ---------------------------------------------------------------------------
  // OPERATOR EDIT AREA
  // Paste one exact filename per line, at column 1. Do not add bullets or quotes.
  // Leading/trailing whitespace is rejected instead of silently normalized.
  // ---------------------------------------------------------------------------
  const FILE_NAMES_TEXT = String.raw`
PASTE_ONE_EXACT_FILENAME_PER_LINE_HERE.pdf
`;
  // ---------------------------------------------------------------------------
  // END OPERATOR EDIT AREA
  // ---------------------------------------------------------------------------

  const SETTINGS = Object.freeze({
    batchSize: 4,
    maxQueryAttempts: 3, // initial batch, then two singleton attempts
    maxTransportAttempts: 3,
    maxDownloadAttempts: 3,
    resultTimeoutMs: 5 * 60 * 1000,
    minInterBatchDelayMs: 1500,
    maxInterBatchDelayMs: 3000,
    statePrefix: "kb_retrieval_state_v3:",
    requestTemplateKey: "kb_retrieval_request_template_v3",
    currentStatePointerKey: "kb_retrieval_current_state_v3",
  });

  const PROMPT_PREFIX = `<instruction>
Retrieve the release / issue date of each of those files listed below, backing off precision-wise to month and year if such information was not available. Strictly adhering to those rules:
<rules>
1. Cite each file EXACTLY ONCE.
2. Clarification to rule 1: A file is defined exclusively by name, the attachment to a file should be treated as an independent file and cited independently. e.g. GAAM_Alert_2025_31_Attachment_1 and GAAM_Alert_2025_31 are distinct files, citing them each is NOT replication.
3. Each subfile, e.g Attachments to a parent file, MUST also be cited INDIVIDUALLY.
</rules>
Escape hatch:
If a specific file is not reachable by name, flag it in your final report and continue the process, instead of terminating.
</instruction>
<output_format>
Example:
1. UN_GAAM_ALERT_2025_31.pdf -> 2025 - 09 - 15 cite 1
2. GAAM_Alert_2025_31_Attachment_1.pdf -> 2025 - 09 - 15 cite 2
Citations:
[1] Assurance Knowledge Agent/UN_GAAM_ALERT_2025_31.pdf page: [ 1 ]
[2] Assurance Knowledge Agent/GAAM_Alert_2025_31_Attachment_1.pdf page: [ 1 ]
Disclaimer:
They are distinct files, despite the former being the latter's parent.
</output_format>

<list_of_files>`;

  const PROMPT_SUFFIX = `</list_of_files>`;

  const SINGLETON_PROMPT_TEMPLATE = `<instruction>
Retrieve the file with this EXACT name:
<file_name>{{FILE_NAME}}</file_name>

A file is defined exclusively by its name. The attachment to a file should be treated as an independent file and cited independently. e.g. GAAM_Alert_2025_31_Attachment_1 and GAAM_Alert_2025_31 are distinct files.

If the first search misses, retry recursively: max 3 queries, max depth 4.

Then quote the first line of the matched file. Read nothing further.
Check NOTHING beyond that.

Output exactly one line:
FOUND: <first line>   — with exactly one citation, to this file only.
NOT FOUND: {{FILE_NAME}}   — with no citation.
</instruction>`;
  const root = typeof window !== "undefined" ? window : globalThis;
  const nativeFetch = typeof root.fetch === "function" ? root.fetch.bind(root) : null;

  let requestTemplate = loadJson(SETTINGS.requestTemplateKey);
  let state = null;
  let stateKey = null;
  let dirHandle = null;
  let outputMode = null; // "directory" | "browser"
  let running = false;
  let stopRequested = false;
  let captureOriginalFetch = null;

  class KbError extends Error {
    constructor(message, code, details) {
      super(message);
      this.name = this.constructor.name;
      this.code = code;
      this.details = details;
    }
  }

  class FatalError extends KbError {}
  class AuthHaltError extends FatalError {}
  class RateLimitHaltError extends FatalError {}
  class SchemaError extends FatalError {}
  class TransportError extends KbError {}

  function now() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function deepClone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function loadJson(key) {
    try {
      const value = root.localStorage?.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.warn(`[kb] Could not read ${key}:`, error);
      return null;
    }
  }

  function saveJson(key, value) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      throw new FatalError(
        `Could not persist progress in Local Storage: ${error.message}`,
        "STATE_WRITE_FAILED",
      );
    }
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function parseFileNames(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();

    const files = [];
    const duplicates = [];
    const seen = new Set();

    lines.forEach((line, index) => {
      if (line === "") return;
      if (line !== line.trim()) {
        throw new FatalError(
          `Filename line ${index + 1} has leading or trailing whitespace. Fix it explicitly: ${JSON.stringify(line)}`,
          "INVALID_FILENAME_WHITESPACE",
        );
      }
      if (line.includes("\0") || line.includes("\n")) {
        throw new FatalError(`Filename line ${index + 1} contains an invalid control character.`, "INVALID_FILENAME");
      }
      if (line.includes("/") || line.includes("\\")) {
        throw new FatalError(
          `Expected filenames must be bare names, not paths (line ${index + 1}): ${JSON.stringify(line)}`,
          "EXPECTED_NAME_IS_PATH",
        );
      }
      if (seen.has(line)) {
        duplicates.push(line);
      } else {
        seen.add(line);
        files.push(line);
      }
    });

    if (!files.length) {
      throw new FatalError("No filenames were found in FILE_NAMES_TEXT.", "NO_FILES");
    }
    if (files.length === 1 && files[0] === "PASTE_ONE_EXACT_FILENAME_PER_LINE_HERE.pdf") {
      throw new FatalError("Replace the placeholder in FILE_NAMES_TEXT before running.", "FILES_NOT_CONFIGURED");
    }
    return { files, duplicates };
  }

  /*
   * The only returned-name normalization permitted:
   * remove an optional agent/path prefix by selecting the final path segment.
   * The resulting string is compared with JavaScript's case-sensitive ===.
   * No trimming, case folding, Unicode folding, suffix removal, or fuzzy matching.
   */
  function returnedFileIdentity(rawName) {
    if (typeof rawName !== "string" || rawName.length === 0) {
      throw new SchemaError("Citation file_name must be a non-empty string.", "BAD_CITATION_FILENAME", { rawName });
    }
    const slash = rawName.lastIndexOf("/");
    const identity = slash >= 0 ? rawName.slice(slash + 1) : rawName;
    if (!identity) {
      throw new SchemaError("Citation file_name ends with a path separator.", "BAD_CITATION_FILENAME", { rawName });
    }
    return identity;
  }

  function isExactFileMatch(returnedName, expectedName) {
    return returnedFileIdentity(returnedName) === expectedName;
  }

  function buildPrompt(fileNames) {
    if (!Array.isArray(fileNames) || fileNames.length < 1 || fileNames.length > SETTINGS.batchSize) {
      throw new FatalError(`A prompt batch must contain 1-${SETTINGS.batchSize} filenames.`, "BAD_BATCH_SIZE");
    }
    if (fileNames.length === 1) {
      return SINGLETON_PROMPT_TEMPLATE.split("{{FILE_NAME}}").join(fileNames[0]);
    }
    return `${PROMPT_PREFIX}\n${fileNames.join("\n")}\n${PROMPT_SUFFIX}`;
  }

  function normalizeStoredToken(value) {
    if (typeof value !== "string") return null;
    let candidate = value;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") candidate = parsed;
    } catch (_) {
      // Local Storage often contains a raw JWT rather than JSON.
    }
    if (candidate.startsWith("Bearer ")) candidate = candidate.slice(7);
    return candidate.startsWith("eyJ") ? candidate : null;
  }

  function tokenCandidates(tokenToMatch = null) {
    const candidates = [];
    for (let i = 0; i < root.localStorage.length; i += 1) {
      const key = root.localStorage.key(i);
      const token = normalizeStoredToken(root.localStorage.getItem(key));
      if (token && (!tokenToMatch || token === tokenToMatch)) candidates.push(key);
    }
    return candidates;
  }

  function readBearerToken() {
    if (!requestTemplate?.tokenStorageKey) {
      throw new AuthHaltError(
        "No token Local Storage key is configured. Run kb.tokenCandidates(), then kb.setTokenKey(\"key\").",
        "TOKEN_KEY_MISSING",
      );
    }
    const token = normalizeStoredToken(root.localStorage.getItem(requestTemplate.tokenStorageKey));
    if (!token) {
      throw new AuthHaltError(
        `Local Storage key ${JSON.stringify(requestTemplate.tokenStorageKey)} does not currently contain a JWT.`,
        "TOKEN_MISSING",
      );
    }
    return token;
  }

  function filteredHeaders(inputHeaders) {
    const headers = new Headers(inputHeaders || {});
    const output = {};
    // Discovery confirmed that Prompt needs no custom header beyond Bearer.
    // Whitelist only representation headers so no copied credential-like value
    // can be persisted accidentally.
    const keep = new Set(["accept", "content-type"]);
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!keep.has(lower)) return;
      output[key] = value;
    });
    return output;
  }

  function sanitizeCapturedRequest(input, init = {}) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    if (!url) throw new FatalError("The copied fetch request has no URL.", "CAPTURE_URL_MISSING");

    const parsedUrl = new URL(url, root.location?.href || undefined);
    if (parsedUrl.pathname.toLowerCase() !== "/api/prompt/") {
      throw new FatalError(`Expected /api/Prompt/ but captured ${parsedUrl.pathname}.`, "WRONG_CAPTURE_REQUEST");
    }

    const method = String(init.method || input?.method || "GET").toUpperCase();
    if (method !== "POST") throw new FatalError(`Expected POST but captured ${method}.`, "WRONG_CAPTURE_METHOD");

    const allHeaders = new Headers(init.headers || input?.headers || {});
    const authorization = allHeaders.get("authorization") || "";
    const capturedToken = authorization.replace(/^Bearer\s+/i, "");
    if (!capturedToken.startsWith("eyJ")) {
      throw new FatalError("The copied Prompt request does not contain the expected Bearer JWT.", "CAPTURE_TOKEN_MISSING");
    }

    const rawBody = init.body;
    if (typeof rawBody !== "string") {
      throw new FatalError("The copied Prompt request body is not a JSON string.", "CAPTURE_BODY_MISSING");
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (error) {
      throw new FatalError(`Could not parse the copied Prompt body: ${error.message}`, "CAPTURE_BODY_INVALID");
    }
    if (!payload || typeof payload !== "object" || !payload.model_params || !("user_session_id" in payload.model_params)) {
      throw new FatalError(
        "The copied Prompt body lacks model_params.user_session_id.",
        "CAPTURE_SESSION_FIELD_MISSING",
      );
    }
    if (!("content" in payload)) {
      throw new FatalError("The copied Prompt body lacks content.", "CAPTURE_CONTENT_FIELD_MISSING");
    }

    const matchingTokenKeys = tokenCandidates(capturedToken);
    const jwtKeyCandidates = tokenCandidates();
    const templatePayload = deepClone(payload);
    templatePayload.content = "";
    templatePayload.model_params.user_session_id = "";

    return {
      version: 1,
      capturedAt: now(),
      promptUrl: parsedUrl.href,
      sessionUrl: new URL("/api/Tools/GetSessionId", parsedUrl).href,
      headers: filteredHeaders(allHeaders),
      payload: templatePayload,
      tokenStorageKey: matchingTokenKeys.length === 1 ? matchingTokenKeys[0] : null,
      tokenCandidateKeys: matchingTokenKeys.length ? matchingTokenKeys : jwtKeyCandidates,
    };
  }

  function armCopyAsFetchCapture() {
    if (!nativeFetch) throw new FatalError("window.fetch is unavailable.", "FETCH_UNAVAILABLE");
    if (captureOriginalFetch) throw new FatalError("A Copy-as-fetch capture is already armed.", "CAPTURE_ALREADY_ARMED");

    captureOriginalFetch = root.fetch;
    root.fetch = async function kbCaptureFetch(input, init) {
      let pathname = "";
      try {
        const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
        pathname = new URL(url, root.location?.href || undefined).pathname.toLowerCase();
      } catch (_) {
        return captureOriginalFetch.call(this, input, init);
      }

      if (pathname !== "/api/prompt/") {
        return captureOriginalFetch.call(this, input, init);
      }

      const original = captureOriginalFetch;
      root.fetch = original;
      captureOriginalFetch = null;

      requestTemplate = sanitizeCapturedRequest(input, init);
      saveJson(SETTINGS.requestTemplateKey, requestTemplate);
      state = null;
      stateKey = null;

      console.info("[kb] Prompt request captured without sending it again.");
      console.table(captureSummary());
      if (!requestTemplate.tokenStorageKey) {
        console.warn(
          "[kb] The token key was ambiguous. Run kb.tokenCandidates(), then kb.setTokenKey(\"exact-key\").",
        );
      }

      return new Response(JSON.stringify({ captured: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    console.info(
      "[kb] Capture armed. Paste the unedited DevTools ‘Copy as fetch’ command for POST /api/Prompt/. It will be captured but not sent.",
    );
  }

  function cancelCapture() {
    if (captureOriginalFetch) {
      root.fetch = captureOriginalFetch;
      captureOriginalFetch = null;
      console.info("[kb] Request capture cancelled.");
    }
  }

  function captureSummary() {
    if (!requestTemplate) return { configured: false };
    return {
      configured: true,
      prompt_origin: new URL(requestTemplate.promptUrl).origin,
      prompt_path: new URL(requestTemplate.promptUrl).pathname,
      session_path: new URL(requestTemplate.sessionUrl).pathname,
      result_path_template: "/api/PrompResponse/{prompt_resp_id}",
      model_ids: JSON.stringify(requestTemplate.payload?.list_model_id || []),
      has_data_source_id: Boolean(requestTemplate.payload?.model_params?.data_source_id),
      has_persona_id: Boolean(requestTemplate.payload?.model_params?.prompt_persona_id),
      token_key: requestTemplate.tokenStorageKey || "SELECT REQUIRED",
      bearer_value_stored: false,
    };
  }

  function setTokenKey(key) {
    if (!requestTemplate) throw new FatalError("Capture a Prompt request first.", "REQUEST_NOT_CONFIGURED");
    if (typeof key !== "string" || !key) throw new FatalError("Token key must be a non-empty string.", "BAD_TOKEN_KEY");
    const token = normalizeStoredToken(root.localStorage.getItem(key));
    if (!token) throw new FatalError(`Local Storage key ${JSON.stringify(key)} does not contain a JWT.`, "BAD_TOKEN_KEY");
    requestTemplate.tokenStorageKey = key;
    requestTemplate.tokenCandidateKeys = [key];
    saveJson(SETTINGS.requestTemplateKey, requestTemplate);
    console.info(`[kb] Token key selected: ${key}. The token value was not stored.`);
  }

  function agentSignature() {
    if (!requestTemplate) throw new FatalError("Capture a Prompt request first.", "REQUEST_NOT_CONFIGURED");
    const payload = requestTemplate.payload;
    return fnv1a(
      JSON.stringify({
        promptOrigin: new URL(requestTemplate.promptUrl).origin,
        list_model_id: payload.list_model_id,
        data_source_id: payload.model_params?.data_source_id,
        prompt_persona_id: payload.model_params?.prompt_persona_id,
      }),
    );
  }

  function getState() {
    if (state) return state;
    if (!requestTemplate) throw new FatalError("Capture a Prompt request first.", "REQUEST_NOT_CONFIGURED");
    if (!requestTemplate.tokenStorageKey) {
      throw new AuthHaltError("Select the token key before initializing the run.", "TOKEN_KEY_MISSING");
    }

    const parsed = parseFileNames(FILE_NAMES_TEXT);
    const listSignature = fnv1a(parsed.files.join("\n"));
    stateKey = `${SETTINGS.statePrefix}${agentSignature()}:${listSignature}`;
    state = loadJson(stateKey);

    if (!state) {
      state = {
        version: 5,
        harnessVersion: VERSION,
        createdAt: now(),
        updatedAt: now(),
        agentSignature: agentSignature(),
        listSignature,
        inputDuplicates: parsed.duplicates,
        stopReason: null,
        meta: {
          stickyInterBatchDelayMs: SETTINGS.minInterBatchDelayMs,
          queryCount: 0,
          sessionCount: 0,
          resultGetCount: 0,
          downloadCount: 0,
          hashCollisions: [],
        },
        batches: [],
        pendingResults: [],
        rows: parsed.files.map((fileName, index) => ({
          index,
          fileName,
          synthetic: false,
          status: "pending",
          queryAttempts: 0,
          citations: [],
          documents: [],
          errors: [],
          updatedAt: now(),
        })),
      };
      persistState();
    } else {
      migrateState();
      recoverInterruptedState();
    }
    root.localStorage.setItem(SETTINGS.currentStatePointerKey, stateKey);
    return state;
  }

  function migrateState() {
    let changed = false;
    const migratingRetryLadder = state.version === 4 || state.harnessVersion === "1.1.0";
    if (!Array.isArray(state.pendingResults)) {
      state.pendingResults = [];
      changed = true;
    }
    if (!state.meta || typeof state.meta !== "object") {
      state.meta = {};
      changed = true;
    }
    for (const key of ["queryCount", "sessionCount", "resultGetCount", "downloadCount"]) {
      if (!Number.isFinite(state.meta[key])) {
        state.meta[key] = 0;
        changed = true;
      }
    }
    if (!Number.isFinite(state.meta.stickyInterBatchDelayMs)) {
      state.meta.stickyInterBatchDelayMs = SETTINGS.minInterBatchDelayMs;
      changed = true;
    }
    if (!Array.isArray(state.meta.hashCollisions)) {
      state.meta.hashCollisions = [];
      changed = true;
    }
    for (const row of state.rows || []) {
      if (typeof row.synthetic !== "boolean") {
        row.synthetic = false;
        changed = true;
      }
      for (const key of ["citations", "documents", "errors"]) {
        if (!Array.isArray(row[key])) {
          row[key] = [];
          changed = true;
        }
      }
    }
    if (migratingRetryLadder) {
      for (const row of state.rows.filter((item) => !item.synthetic && item.documents.length === 0)) {
        const completedAttempts = (state.batches || []).filter(
          (batch) => Array.isArray(batch.files) && batch.files.includes(row.fileName),
        );
        const singletonRetries = completedAttempts
          .slice(1)
          .filter((batch) => batch.files.length === 1)
          .length;
        const effectiveAttempts = Math.min(
          SETTINGS.maxQueryAttempts,
          (completedAttempts.length > 0 ? 1 : 0) + Math.min(2, singletonRetries),
        );
        if (row.queryAttempts !== effectiveAttempts) {
          const oldAttempts = row.queryAttempts;
          row.queryAttempts = effectiveAttempts;
          row.errors.push({
            at: now(),
            code: "RETRY_LADDER_MIGRATED",
            message: `Migrated v1.1.0 retry history from ${oldAttempts} total attempt(s) to ${effectiveAttempts} effective batch→singleton→singleton attempt(s).`,
          });
          row.updatedAt = now();
          changed = true;
        }
        if (row.status === "failed" && effectiveAttempts < SETTINGS.maxQueryAttempts) {
          row.status = "pending";
          changed = true;
        }
      }
    }
    if (state.version !== 5 || state.harnessVersion !== VERSION) {
      state.version = 5;
      state.harnessVersion = VERSION;
      changed = true;
    }
    if (changed) persistState();
  }

  function recoverInterruptedState() {
    let changed = false;
    const pendingRowIndexes = new Set(
      (state.pendingResults || []).flatMap((pending) =>
        Array.isArray(pending.rowIndexes) ? pending.rowIndexes : [],
      ),
    );
    for (const row of state.rows) {
      if (row.status === "querying") {
        row.status = pendingRowIndexes.has(row.index) ? "awaiting_result" : "pending";
        row.errors.push({
          at: now(),
          code: "RECOVERED_QUERY",
          message: pendingRowIndexes.has(row.index)
            ? "Recovered an acknowledged prompt; its result GET will resume without resubmitting."
            : "Recovered an interrupted prompt submission before an acknowledgement was saved.",
        });
        changed = true;
      } else if (row.status === "awaiting_result" && !pendingRowIndexes.has(row.index)) {
        row.status = "pending";
        row.errors.push({
          at: now(),
          code: "ORPHANED_RESULT",
          message: "No saved prompt_resp_id was available; the file was returned to the query queue.",
        });
        changed = true;
      } else if (row.status === "downloading") {
        row.status = "cited";
        row.errors.push({ at: now(), code: "RECOVERED_DOWNLOAD", message: "Recovered an interrupted download." });
        changed = true;
      }
    }
    if (changed) persistState();
  }

  function persistState() {
    if (!state || !stateKey) return;
    state.updatedAt = now();
    saveJson(stateKey, state);
  }

  function addRowError(row, error, code = null) {
    row.errors.push({
      at: now(),
      code: code || error.code || error.name || "ERROR",
      message: error.message || String(error),
    });
    row.updatedAt = now();
  }

  function parseRetryAfter(response) {
    const value = response.headers.get("retry-after");
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  function bearerHeaders(baseHeaders = {}) {
    return {
      ...baseHeaders,
      authorization: `Bearer ${readBearerToken()}`,
    };
  }

  async function fetchBearerWithPolicy(
    url,
    init,
    operation,
    { retryTransient = true, timeoutMs = null } = {},
  ) {
    let authRetries = 0;
    let rateRetries = 0;
    let transientRetries = 0;
    const rateBackoff = [30000, 60000, 120000, 240000];

    while (true) {
      let response;
      let timeoutId = null;
      const controller = timeoutMs ? new AbortController() : null;
      try {
        if (controller) timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        response = await nativeFetch(url, {
          ...init,
          headers: bearerHeaders(init.headers),
          credentials: "include",
          mode: "cors",
          signal: controller?.signal,
        });
      } catch (error) {
        const timedOut = Boolean(controller?.signal.aborted);
        if (!retryTransient) {
          throw new TransportError(
            timedOut
              ? `${operation} exceeded the ${Math.round(timeoutMs / 1000)}-second timeout.`
              : `${operation} failed at the network layer: ${error.message}`,
            timedOut ? "REQUEST_TIMEOUT" : "NETWORK_FAILED",
          );
        }
        if (transientRetries >= 2) {
          throw new TransportError(
            timedOut
              ? `${operation} timed out after repeated attempts.`
              : `${operation} failed after network retries: ${error.message}`,
            timedOut ? "REQUEST_TIMEOUT" : "NETWORK_FAILED",
          );
        }
        await sleep(2000 * 2 ** transientRetries);
        transientRetries += 1;
        continue;
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
      }

      if (response.status === 401) {
        if (authRetries >= 1) {
          throw new AuthHaltError(
            `${operation} returned 401 twice. Refresh/sign in, rerun the snippet, reselect the folder, and resume.`,
            "AUTH_401",
          );
        }
        authRetries += 1;
        await sleep(1500);
        continue;
      }

      if (response.status === 429) {
        if (rateRetries >= rateBackoff.length) {
          throw new RateLimitHaltError(`${operation} remained rate-limited after four backoffs.`, "RATE_LIMIT_HALT");
        }
        const waitMs = parseRetryAfter(response) ?? rateBackoff[rateRetries];
        if (state) {
          state.meta.stickyInterBatchDelayMs = Math.min(
            60000,
            Math.max(state.meta.stickyInterBatchDelayMs * 2, 5000),
          );
          persistState();
        }
        console.warn(`[kb] ${operation} returned 429; waiting ${Math.ceil(waitMs / 1000)} seconds.`);
        rateRetries += 1;
        await sleep(waitMs);
        continue;
      }

      if (response.status >= 500 && response.status <= 599) {
        if (!retryTransient) {
          throw new TransportError(`${operation} returned HTTP ${response.status}.`, "SERVER_FAILED");
        }
        if (transientRetries >= 2) {
          throw new TransportError(`${operation} returned HTTP ${response.status} after retries.`, "SERVER_FAILED");
        }
        await sleep(3000 * 2 ** transientRetries);
        transientRetries += 1;
        continue;
      }

      return response;
    }
  }

  function parseSessionId(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SchemaError(`GetSessionId response was not JSON: ${error.message}`, "BAD_SESSION_RESPONSE");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SchemaError("GetSessionId response was not an envelope object.", "BAD_SESSION_RESPONSE");
    }
    if (parsed.success !== true) {
      throw new SchemaError(
        `GetSessionId reported failure: ${safeDiagnosticText(parsed.ret_msg || "unknown error")}`,
        "SESSION_REPORTED_FAILURE",
      );
    }
    if (typeof parsed.data !== "string" || parsed.data.length === 0) {
      throw new SchemaError("GetSessionId data was not a non-empty string.", "BAD_SESSION_RESPONSE");
    }
    return parsed.data;
  }

  function safeDiagnosticText(value) {
    if (typeof value !== "string") return value ?? null;
    return value
      .replace(/Bearer\s+eyJ[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[JWT REDACTED]")
      .slice(0, 500);
  }

  function valueType(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  function objectKeys(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  }

  function summarizePromptEnvelope(payload) {
    const data = payload && typeof payload === "object" ? payload.data : undefined;
    let parsedDataString = null;
    if (typeof data === "string") {
      try {
        parsedDataString = JSON.parse(data);
      } catch (_) {
        // The string may be ordinary assistant text. Its contents are not logged.
      }
    }
    return {
      topLevelType: valueType(payload),
      topLevelKeys: objectKeys(payload),
      success: payload && typeof payload === "object" ? payload.success ?? null : null,
      ret_msg: safeDiagnosticText(payload && typeof payload === "object" ? payload.ret_msg : null),
      message: safeDiagnosticText(payload && typeof payload === "object" ? payload.message : null),
      error: safeDiagnosticText(payload && typeof payload === "object" ? payload.error : null),
      dataType: valueType(data),
      dataKeys: objectKeys(data),
      dataLength: Array.isArray(data) ? data.length : null,
      dataStringLength: typeof data === "string" ? data.length : null,
      dataStringParsesAsJson: parsedDataString !== null,
      parsedDataType: valueType(parsedDataString),
      parsedDataKeys: objectKeys(parsedDataString),
    };
  }

  async function createSession() {
    const response = await fetchBearerWithPolicy(
      requestTemplate.sessionUrl,
      { method: "GET", headers: { accept: "application/json" } },
      "GetSessionId",
    );
    if (!response.ok) {
      throw new FatalError(`GetSessionId returned HTTP ${response.status}.`, "SESSION_HTTP_ERROR");
    }
    const id = parseSessionId(await response.text());
    state.meta.sessionCount += 1;
    persistState();
    return id;
  }

  function parsePromptAck(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SchemaError("Prompt acknowledgement was not an envelope object.", "BAD_PROMPT_ACK");
    }
    const firstError = Array.isArray(payload.data) ? payload.data[0]?.error_message : null;
    if (payload.success !== true) {
      const messages = [payload.ret_msg, firstError]
        .filter((message) => typeof message === "string" && message.length > 0)
        .map((message) => safeDiagnosticText(message));
      throw new FatalError(
        `Prompt acknowledgement reported failure: ${messages.length ? messages.join(" | ") : "no error message"}`,
        "PROMPT_ACK_REPORTED_FAILURE",
      );
    }
    if (!Array.isArray(payload.data) || payload.data.length === 0) {
      throw new SchemaError("Prompt acknowledgement data was not a non-empty array.", "BAD_PROMPT_ACK");
    }
    const first = payload.data[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) {
      throw new SchemaError("Prompt acknowledgement data[0] was not an object.", "BAD_PROMPT_ACK");
    }
    if (typeof first.error_message === "string" && first.error_message.length > 0) {
      const details = [payload.ret_msg, first.error_message]
        .filter((message) => typeof message === "string" && message.length > 0)
        .map((message) => safeDiagnosticText(message))
        .join(" | ");
      throw new FatalError(
        `Prompt acknowledgement reported an error: ${details}`,
        "PROMPT_ACK_ERROR",
      );
    }
    if (typeof first.prompt_resp_id !== "string" || first.prompt_resp_id.length === 0) {
      throw new SchemaError("Prompt acknowledgement data[0].prompt_resp_id was missing.", "BAD_PROMPT_ACK");
    }
    return {
      promptRespId: first.prompt_resp_id,
      modelId: typeof first.model_id === "string" ? first.model_id : null,
      description: typeof first.description === "string" ? first.description : null,
    };
  }

  function parsePromptResult(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SchemaError("Prompt result was not an envelope object.", "BAD_PROMPT_RESULT");
    }
    if (payload.success !== true) {
      throw new FatalError(
        `Prompt result reported failure: ${safeDiagnosticText(payload.ret_msg || "no error message")}`,
        "PROMPT_RESULT_REPORTED_FAILURE",
      );
    }
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
      throw new SchemaError("Prompt result data was not an object.", "BAD_PROMPT_RESULT");
    }
    if (typeof payload.data.prompt_resp_id !== "string" || payload.data.prompt_resp_id.length === 0) {
      throw new SchemaError("Prompt result prompt_resp_id was missing.", "BAD_PROMPT_RESULT");
    }

    const rawCitations = payload.data.list_page_info;
    if (rawCitations !== undefined && rawCitations !== null && !Array.isArray(rawCitations)) {
      throw new SchemaError("Prompt result list_page_info was present but was not an array.", "BAD_PROMPT_RESULT");
    }
    const citations = (rawCitations || []).map((item, itemIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new SchemaError(`Citation ${itemIndex} was not an object.`, "BAD_CITATION_ITEM");
      }
      if (typeof item.index !== "string") {
        throw new SchemaError(`Citation ${itemIndex} index was not a string.`, "BAD_CITATION_ITEM");
      }
      if (typeof item.file_name !== "string" || item.file_name.length === 0) {
        throw new SchemaError(`Citation ${itemIndex} file_name was missing.`, "BAD_CITATION_ITEM");
      }
      if (
        !Array.isArray(item.page_no) ||
        item.page_no.some((page) => !Number.isInteger(page) || page < 1)
      ) {
        throw new SchemaError(`Citation ${itemIndex} page_no was not a list of positive integers.`, "BAD_CITATION_ITEM");
      }
      if (typeof item.s3_url !== "string") {
        throw new SchemaError(`Citation ${itemIndex} s3_url was missing.`, "BAD_CITATION_ITEM");
      }
      try {
        const parsedUrl = new URL(item.s3_url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("unsupported protocol");
      } catch (error) {
        throw new SchemaError(`Citation ${itemIndex} s3_url was not an absolute HTTP(S) URL.`, "BAD_CITATION_ITEM");
      }
      return {
        index: item.index,
        file_name: item.file_name,
        page_no: [...item.page_no],
        s3_url: item.s3_url,
      };
    });

    const followUps = payload.data.follow_up_prompt_resp_ids;
    if (followUps !== undefined && followUps !== null && !Array.isArray(followUps)) {
      throw new SchemaError("Prompt result follow_up_prompt_resp_ids was not an array.", "BAD_PROMPT_RESULT");
    }
    if ((followUps || []).some((id) => typeof id !== "string" || id.length === 0)) {
      throw new SchemaError(
        "Prompt result follow_up_prompt_resp_ids contained a non-string ID.",
        "BAD_PROMPT_RESULT",
      );
    }
    return {
      promptRespId: payload.data.prompt_resp_id,
      modelId: typeof payload.data.model_id === "string" ? payload.data.model_id : null,
      createdTime:
        typeof payload.data.created_time === "string" ? payload.data.created_time : null,
      citations,
      followUpPromptRespIds: [...(followUps || [])],
    };
  }

  function extractDocumentHash(url) {
    let parsed;
    try {
      parsed = new URL(url, root.location?.href || undefined);
    } catch (error) {
      throw new SchemaError(`Citation URL is invalid: ${error.message}`, "BAD_CITATION_URL", { url });
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const getFileIndex = parts.findIndex((part) => part.toLowerCase() === "getfile");
    if (getFileIndex < 0 || !parts[getFileIndex + 1]) {
      throw new SchemaError("Citation URL does not contain /getfile/<hash>/.", "CITATION_HASH_MISSING", { url });
    }
    return parts[getFileIndex + 1];
  }

  function groupMatchingCitations(row, citations) {
    const matching = citations.filter((citation) => isExactFileMatch(citation.file_name, row.fileName));
    const groups = new Map();
    for (const citation of matching) {
      const documentHash = extractDocumentHash(citation.s3_url);
      if (!groups.has(documentHash)) groups.set(documentHash, []);
      groups.get(documentHash).push({ ...citation, document_hash: documentHash });
    }
    return { matching, groups };
  }

  function groupCitationsByHash(citations) {
    const groups = new Map();
    for (const citation of citations) {
      const documentHash = extractDocumentHash(citation.s3_url);
      if (!groups.has(documentHash)) groups.set(documentHash, []);
      groups.get(documentHash).push({ ...citation, document_hash: documentHash });
    }
    return groups;
  }

  function rowHasSavedOrExistingDocument(row) {
    return row.documents.some((document) => ["saved", "existing"].includes(document.status));
  }

  function knownDocumentHashes() {
    return new Set(
      state.rows.flatMap((row) => row.documents.map((document) => document.documentHash)),
    );
  }

  async function readJsonResponse(response, operation) {
    try {
      return await response.json();
    } catch (error) {
      throw new SchemaError(`${operation} response was not JSON: ${error.message}`, "RESPONSE_NOT_JSON");
    }
  }

  async function submitBatchOnce(fileNames) {
    const sessionId = await createSession();
    const payload = deepClone(requestTemplate.payload);
    payload.content = buildPrompt(fileNames);
    payload.model_params.user_session_id = sessionId;

    const response = await fetchBearerWithPolicy(
      requestTemplate.promptUrl,
      {
        method: "POST",
        headers: requestTemplate.headers,
        body: JSON.stringify(payload),
      },
      "Prompt",
      { retryTransient: false },
    );
    if (!response.ok) {
      const snippet = (await response.text()).slice(0, 500);
      if (response.status >= 400 && response.status < 500) {
        throw new FatalError(`Prompt returned HTTP ${response.status}: ${snippet}`, "PROMPT_HTTP_ERROR");
      }
      throw new TransportError(`Prompt returned HTTP ${response.status}.`, "PROMPT_TRANSPORT_ERROR");
    }

    const acknowledgement = parsePromptAck(await readJsonResponse(response, "Prompt acknowledgement"));
    state.meta.queryCount += 1;
    persistState();
    return { sessionId, ...acknowledgement };
  }

  async function submitBatchWithTransportRetries(fileNames) {
    let lastError = null;
    for (let attempt = 1; attempt <= SETTINGS.maxTransportAttempts; attempt += 1) {
      try {
        return await submitBatchOnce(fileNames);
      } catch (error) {
        if (error instanceof FatalError || error instanceof AuthHaltError || error instanceof RateLimitHaltError) throw error;
        lastError = error;
        if (attempt < SETTINGS.maxTransportAttempts) {
          console.warn(`[kb] Transport attempt ${attempt} failed; retrying in a fresh conversation.`, error);
          await sleep(3000 * attempt);
        }
      }
    }
    throw new TransportError(
      `Batch transport failed after ${SETTINGS.maxTransportAttempts} fresh conversations: ${lastError?.message}`,
      "BATCH_TRANSPORT_FAILED",
    );
  }

  function resultUrl(promptRespId) {
    // The missing "t" in PrompResponse is a deployed server-side API typo.
    // Preserve it literally.
    return new URL(
      `/api/PrompResponse/${encodeURIComponent(promptRespId)}`,
      requestTemplate.promptUrl,
    ).href;
  }

  function registerPendingResult(rows, acknowledgement) {
    const pending = {
      promptRespId: acknowledgement.promptRespId,
      modelId: acknowledgement.modelId,
      description: acknowledgement.description,
      sessionId: acknowledgement.sessionId,
      rowIndexes: rows.map((row) => row.index),
      files: rows.map((row) => row.fileName),
      status: "awaiting_result",
      submittedAt: now(),
      resultGetAttempts: 0,
      lastResultGetAt: null,
      lastError: null,
    };
    if (state.pendingResults.some((item) => item.promptRespId === pending.promptRespId)) {
      throw new SchemaError(
        `Duplicate pending prompt_resp_id ${pending.promptRespId}.`,
        "DUPLICATE_PROMPT_RESPONSE_ID",
      );
    }
    state.pendingResults.push(pending);
    rows.forEach((row) => {
      row.status = "awaiting_result";
      row.pendingPromptRespId = pending.promptRespId;
      row.updatedAt = now();
    });
    // Persist the response ID before starting the long-held GET. A reload can
    // now resume the GET without ever resubmitting the prompt.
    persistState();
    return pending;
  }

  async function getPromptResultOnce(pending) {
    pending.resultGetAttempts += 1;
    pending.lastResultGetAt = now();
    pending.lastError = null;
    state.meta.resultGetCount += 1;
    persistState();

    const response = await fetchBearerWithPolicy(
      resultUrl(pending.promptRespId),
      { method: "GET", headers: { accept: "application/json" } },
      `PrompResponse ${pending.promptRespId}`,
      { retryTransient: false, timeoutMs: SETTINGS.resultTimeoutMs },
    );
    if (!response.ok) {
      if (response.status >= 500) {
        throw new TransportError(
          `PrompResponse ${pending.promptRespId} returned HTTP ${response.status}.`,
          "RESULT_SERVER_ERROR",
        );
      }
      throw new FatalError(
        `PrompResponse ${pending.promptRespId} returned HTTP ${response.status}.`,
        "RESULT_HTTP_ERROR",
      );
    }

    const result = parsePromptResult(await readJsonResponse(response, "Prompt result"));
    if (result.promptRespId && result.promptRespId !== pending.promptRespId) {
      throw new SchemaError(
        `Prompt result ID ${result.promptRespId} did not match ${pending.promptRespId}.`,
        "RESULT_ID_MISMATCH",
      );
    }
    return result;
  }

  async function awaitPromptResult(pending) {
    let lastError = null;
    for (let attempt = 1; attempt <= SETTINGS.maxTransportAttempts; attempt += 1) {
      try {
        return await getPromptResultOnce(pending);
      } catch (error) {
        pending.lastError = error.message;
        persistState();
        if (error instanceof FatalError) throw error;
        lastError = error;
        if (attempt < SETTINGS.maxTransportAttempts) {
          console.warn(
            `[kb] Result GET attempt ${attempt} failed; reissuing the GET for ${pending.promptRespId} without resubmitting the prompt.`,
            error,
          );
          await sleep(3000 * attempt);
        }
      }
    }
    throw new TransportError(
      `Result GET for ${pending.promptRespId} failed after ${SETTINGS.maxTransportAttempts} attempts; resume will re-GET the same ID: ${lastError?.message}`,
      "RESULT_GET_FAILED",
      { promptRespId: pending.promptRespId },
    );
  }

  function shortHash(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 12) || "unknown";
  }

  function candidateFileName(original, documentHash, candidateCount, candidateIndex) {
    if (candidateCount === 1) return original;
    const dot = original.lastIndexOf(".");
    const suffix = `__candidate_${candidateIndex + 1}_${shortHash(documentHash)}`;
    return dot > 0 ? `${original.slice(0, dot)}${suffix}${original.slice(dot)}` : `${original}${suffix}`;
  }

  async function sha256Blob(blob) {
    const digest = await root.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function verifyPdfResponse(response) {
    if (!response.ok) throw new TransportError(`Download returned HTTP ${response.status}.`, "DOWNLOAD_HTTP_ERROR");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/pdf")) {
      throw new SchemaError(`Download Content-Type was ${JSON.stringify(contentType)}, not application/pdf.`, "DOWNLOAD_NOT_PDF");
    }
    const blob = await response.blob();
    if (blob.size === 0) throw new SchemaError("Downloaded PDF is empty.", "DOWNLOAD_EMPTY");

    const declaredLength = response.headers.get("content-length");
    if (declaredLength && Number(declaredLength) !== blob.size) {
      throw new SchemaError(
        `Content-Length ${declaredLength} does not match received bytes ${blob.size}.`,
        "DOWNLOAD_LENGTH_MISMATCH",
      );
    }

    const headBytes = new Uint8Array(await blob.slice(0, Math.min(1024, blob.size)).arrayBuffer());
    const head = String.fromCharCode(...headBytes);
    if (!head.includes("%PDF-")) {
      throw new SchemaError("Downloaded bytes do not contain a PDF signature in the first 1,024 bytes.", "DOWNLOAD_BAD_MAGIC");
    }

    return {
      blob,
      bytes: blob.size,
      contentType,
      sha256: await sha256Blob(blob),
    };
  }

  async function existingFileSha256(fileName) {
    try {
      const handle = await dirHandle.getFileHandle(fileName);
      const file = await handle.getFile();
      return { exists: true, sha256: await sha256Blob(file) };
    } catch (error) {
      if (error?.name === "NotFoundError") return { exists: false, sha256: null };
      throw error;
    }
  }

  async function saveToDirectory(fileName, blob, sha256) {
    let outputName = fileName;
    const existing = await existingFileSha256(outputName);
    if (existing.exists && existing.sha256 === sha256) {
      return { savedName: outputName, saveMode: "directory-existing-identical" };
    }
    if (existing.exists) {
      const dot = fileName.lastIndexOf(".");
      const suffix = `__retrieved_${sha256.slice(0, 12)}`;
      outputName = dot > 0 ? `${fileName.slice(0, dot)}${suffix}${fileName.slice(dot)}` : `${fileName}${suffix}`;
      const alternate = await existingFileSha256(outputName);
      if (alternate.exists && alternate.sha256 === sha256) {
        return { savedName: outputName, saveMode: "directory-existing-identical" };
      }
      if (alternate.exists) {
        throw new FatalError(`Both ${fileName} and ${outputName} already exist with different bytes.`, "OUTPUT_COLLISION");
      }
    }

    const handle = await dirHandle.getFileHandle(outputName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { savedName: outputName, saveMode: "directory-verified" };
  }

  function saveViaBrowser(fileName, blob) {
    if (!root.document) throw new FatalError("Browser-download mode requires document APIs.", "DOCUMENT_UNAVAILABLE");
    const objectUrl = URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.style.display = "none";
    root.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    return { savedName: fileName, saveMode: "browser-download-triggered" };
  }

  async function saveVerifiedBlob(fileName, verified) {
    if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
      throw new FatalError(`Unsafe output filename: ${JSON.stringify(fileName)}`, "UNSAFE_OUTPUT_NAME");
    }
    if (outputMode === "directory") return saveToDirectory(fileName, verified.blob, verified.sha256);
    if (outputMode === "browser") return saveViaBrowser(fileName, verified.blob);
    throw new FatalError("Choose an output mode with await kb.pickFolder() or kb.useBrowserDownloads().", "OUTPUT_NOT_SELECTED");
  }

  function noteCrossNameHashCollision(row, documentHash) {
    for (const other of state.rows) {
      if (other.fileName === row.fileName) continue;
      if (other.documents.some((document) => document.documentHash === documentHash)) {
        const key = [other.fileName, row.fileName].sort().join(" | ") + ` | ${documentHash}`;
        if (!state.meta.hashCollisions.some((collision) => collision.key === key)) {
          state.meta.hashCollisions.push({
            key,
            detectedAt: now(),
            documentHash,
            fileNames: [other.fileName, row.fileName].sort(),
            action: "Flagged only; distinct exact filenames were not merged.",
          });
        }
      }
    }
  }

  function reusableDocumentByHash(documentHash, excludedDocument) {
    for (const otherRow of state.rows) {
      for (const otherDocument of otherRow.documents) {
        if (
          otherDocument !== excludedDocument &&
          otherDocument.documentHash === documentHash &&
          ["saved", "existing", "triggered", "unavailable", "failed"].includes(otherDocument.status)
        ) {
          return { row: otherRow, document: otherDocument };
        }
      }
    }
    return null;
  }

  function updateRowStatusFromDocuments(row) {
    const statuses = row.documents.map((item) => item.status);
    const completed = statuses.every((status) => ["saved", "existing", "triggered"].includes(status));
    if (row.synthetic && statuses.length > 0 && completed) {
      row.status = "extra";
    } else if (statuses.every((status) => ["saved", "existing"].includes(status))) {
      row.status = row.documents.length > 1 ? "ambiguous" : "downloaded";
    } else if (completed) {
      row.status = row.documents.length > 1 ? "ambiguous" : "download_triggered";
    } else if (statuses.some((status) => status === "unavailable")) {
      row.status = "unavailable";
    } else if (statuses.every((status) => status === "failed")) {
      row.status = "download_failed";
    } else {
      row.status = "cited";
    }
    row.updatedAt = now();
  }

  async function downloadDocument(row, document) {
    if (["saved", "existing", "triggered"].includes(document.status)) return;
    if (document.downloadAttempts >= SETTINGS.maxDownloadAttempts) return;

    const reusable = reusableDocumentByHash(document.documentHash, document);
    if (reusable) {
      document.status = ["unavailable", "failed", "triggered"].includes(reusable.document.status)
        ? reusable.document.status
        : "existing";
      document.downloadAttempts = Number.isFinite(reusable.document.downloadAttempts)
        ? reusable.document.downloadAttempts
        : 0;
      document.bytes = reusable.document.bytes;
      document.contentType = reusable.document.contentType;
      document.sha256 = reusable.document.sha256;
      document.savedName = reusable.document.savedName;
      document.saveMode = `global-hash-deduplicated:${reusable.document.saveMode || reusable.document.status}`;
      document.lastError = reusable.document.lastError;
      document.updatedAt = now();
      updateRowStatusFromDocuments(row);
      persistState();
      return;
    }

    row.status = "downloading";
    document.status = "downloading";
    document.downloadAttempts += 1;
    document.updatedAt = now();
    persistState();

    try {
      // Intentionally cookie-only: never add the Bearer header to citation downloads.
      const response = await nativeFetch(document.url, {
        method: "GET",
        credentials: "include",
        mode: "cors",
      });
      if (response.status === 403) {
        document.status = "unavailable";
        document.lastError = "Download returned 403.";
        row.status = "unavailable";
        persistState();
        return;
      }
      const verified = await verifyPdfResponse(response);
      const saved = await saveVerifiedBlob(document.outputName, verified);
      document.bytes = verified.bytes;
      document.contentType = verified.contentType;
      document.sha256 = verified.sha256;
      document.savedName = saved.savedName;
      document.saveMode = saved.saveMode;
      document.status = saved.saveMode === "browser-download-triggered" ? "triggered" : saved.saveMode.includes("existing") ? "existing" : "saved";
      document.lastError = null;
      document.updatedAt = now();
      state.meta.downloadCount += 1;
    } catch (error) {
      document.status = document.downloadAttempts >= SETTINGS.maxDownloadAttempts ? "failed" : "pending";
      document.lastError = error.message;
      document.updatedAt = now();
      addRowError(row, error, "DOWNLOAD_FAILED");
    }

    updateRowStatusFromDocuments(row);
    persistState();
  }

  async function downloadPendingForRow(row) {
    for (const document of row.documents) {
      if (stopRequested) break;
      while (
        !stopRequested &&
        ["pending", "downloading"].includes(document.status) &&
        document.downloadAttempts < SETTINGS.maxDownloadAttempts
      ) {
        await downloadDocument(row, document);
        if (document.status === "pending" && document.downloadAttempts < SETTINGS.maxDownloadAttempts) {
          await sleep(2000 * 2 ** (document.downloadAttempts - 1));
        }
      }
    }
  }

  function makeDocuments(row, groups) {
    const groupEntries = Array.from(groups.entries());
    return groupEntries.map(([documentHash, citations], index) => {
      noteCrossNameHashCollision(row, documentHash);
      const baseName = row.synthetic ? `unmatched__${row.fileName}` : row.fileName;
      let outputName = candidateFileName(baseName, documentHash, groupEntries.length, index);
      if (
        row.synthetic &&
        state.rows.some((otherRow) =>
          otherRow.documents.some((document) => document.outputName === outputName),
        )
      ) {
        const dot = baseName.lastIndexOf(".");
        const suffix = `__${shortHash(documentHash)}`;
        outputName = dot > 0
          ? `${baseName.slice(0, dot)}${suffix}${baseName.slice(dot)}`
          : `${baseName}${suffix}`;
      }
      return {
        documentHash,
        url: citations[0].s3_url, // verbatim; never reconstructed
        allCitationUrls: citations.map((citation) => citation.s3_url),
        pages: citations.map((citation) => citation.page_no),
        outputName,
        status: "pending",
        downloadAttempts: 0,
        bytes: null,
        contentType: null,
        sha256: null,
        savedName: null,
        saveMode: null,
        lastError: null,
        updatedAt: now(),
      };
    });
  }

  function mergeRequestedDocuments(row, groups) {
    if (row.documents.length === 0) {
      row.documents = makeDocuments(row, groups);
      updateRowStatusFromDocuments(row);
      return;
    }

    for (const [documentHash, citations] of groups) {
      const existing = row.documents.find((document) => document.documentHash === documentHash);
      if (existing) {
        existing.allCitationUrls = [...new Set([
          ...existing.allCitationUrls,
          ...citations.map((citation) => citation.s3_url),
        ])];
        const pageKeys = new Set(existing.pages.map((pages) => JSON.stringify(pages)));
        for (const citation of citations) {
          const key = JSON.stringify(citation.page_no);
          if (!pageKeys.has(key)) {
            existing.pages.push(citation.page_no);
            pageKeys.add(key);
          }
        }
        existing.updatedAt = now();
        continue;
      }

      const document = makeDocuments(row, new Map([[documentHash, citations]]))[0];
      document.outputName = candidateFileName(
        row.fileName,
        documentHash,
        row.documents.length + 1,
        row.documents.length,
      );
      row.documents.push(document);
    }
    updateRowStatusFromDocuments(row);
  }

  function citationAuditKey(citation, sourcePromptRespId) {
    return [
      sourcePromptRespId || "",
      citation.index,
      citation.file_name,
      JSON.stringify(citation.page_no),
      citation.s3_url,
    ].join("\u0000");
  }

  function appendCitationEvidence(row, citations, sourcePromptRespId, assignment) {
    const existing = new Set(
      row.citations.map((citation) => citationAuditKey(citation, citation.sourcePromptRespId)),
    );
    for (const citation of citations) {
      const citationSourcePromptRespId = citation.sourcePromptRespId || sourcePromptRespId || null;
      const key = citationAuditKey(citation, citationSourcePromptRespId);
      if (existing.has(key)) continue;
      row.citations.push({
        ...citation,
        document_hash: extractDocumentHash(citation.s3_url),
        sourcePromptRespId: citationSourcePromptRespId,
        assignment,
        observedAt: now(),
      });
      existing.add(key);
    }
  }

  function nextSyntheticIndex() {
    return state.rows.reduce((maximum, row) => Math.max(maximum, row.index), -1) + 1;
  }

  function createSyntheticRow(documentHash, citations, sourcePromptRespId) {
    const firstSourcePromptRespId = sourcePromptRespId || citations[0].sourcePromptRespId || null;
    const row = {
      index: nextSyntheticIndex(),
      fileName: returnedFileIdentity(citations[0].file_name),
      synthetic: true,
      status: "cited",
      queryAttempts: SETTINGS.maxQueryAttempts,
      citations: [],
      documents: [],
      errors: [],
      sourcePromptRespId: firstSourcePromptRespId,
      updatedAt: now(),
    };
    appendCitationEvidence(row, citations, firstSourcePromptRespId, "synthetic_unmatched");
    row.documents = makeDocuments(row, new Map([[documentHash, citations]]));
    state.rows.push(row);
    return row;
  }

  function exactExpectedRowsForCitations(citations, excludedRowIndexes) {
    const identities = new Set(citations.map((citation) => returnedFileIdentity(citation.file_name)));
    return state.rows.filter((row) =>
      !row.synthetic &&
      !excludedRowIndexes.has(row.index) &&
      identities.has(row.fileName),
    );
  }

  function reconcileUnclaimedCitationGroups(
    groups,
    claimedHashes,
    sourcePromptRespId,
    excludedRowIndexes = new Set(),
  ) {
    const affectedRows = [];
    const syntheticRows = [];
    const reconciledExpectedRows = [];
    const knownHashes = knownDocumentHashes();

    for (const [documentHash, citations] of groups) {
      const claimed = claimedHashes.has(documentHash);

      const exactExpectedRows = exactExpectedRowsForCitations(citations, excludedRowIndexes);
      let reconciled = false;
      for (const row of exactExpectedRows) {
        const exactCitations = citations.filter((citation) =>
          isExactFileMatch(citation.file_name, row.fileName),
        );
        const sameHashDocument = row.documents.find(
          (document) => document.documentHash === documentHash,
        );
        if (sameHashDocument) {
          appendCitationEvidence(row, exactCitations, sourcePromptRespId, "expected_reconciled");
          reconciled = true;
          continue;
        }
        // Never overwrite a resolved/documented expected row with a newly
        // observed hash. Preserve the new document as an unmatched synthetic.
        if (row.documents.length > 0) continue;

        appendCitationEvidence(row, exactCitations, sourcePromptRespId, "expected_reconciled");
        row.documents = makeDocuments(row, new Map([[documentHash, citations]]));
        row.status = "cited";
        row.updatedAt = now();
        affectedRows.push(row);
        reconciledExpectedRows.push(row);
        knownHashes.add(documentHash);
        reconciled = true;
      }

      if (reconciled || claimed || knownHashes.has(documentHash)) continue;
      const synthetic = createSyntheticRow(documentHash, citations, sourcePromptRespId);
      affectedRows.push(synthetic);
      syntheticRows.push(synthetic);
      knownHashes.add(documentHash);
    }

    return { affectedRows, syntheticRows, reconciledExpectedRows };
  }

  function rowsForPendingResult(pending) {
    const rows = pending.rowIndexes.map((index) => state.rows.find((row) => row.index === index));
    if (rows.some((row) => !row)) {
      throw new SchemaError(
        `Saved result ${pending.promptRespId} refers to a missing row index.`,
        "PENDING_RESULT_ROW_MISSING",
      );
    }
    return rows;
  }

  async function applyPromptResult(pending, result) {
    const rows = rowsForPendingResult(pending);
    if (state.batches.some((batch) => batch.promptRespId === pending.promptRespId)) {
      state.pendingResults = state.pendingResults.filter(
        (item) => item.promptRespId !== pending.promptRespId,
      );
      rows.forEach((row) => delete row.pendingPromptRespId);
      persistState();
      console.warn(`[kb] Result ${pending.promptRespId} was already applied; duplicate application was skipped.`);
      return;
    }
    if (result.followUpPromptRespIds.length > 0) {
      console.warn(
        `[kb] Prompt ${pending.promptRespId} returned follow-up response IDs; they were logged but not fetched:`,
        result.followUpPromptRespIds,
      );
    }

    const batchAudit = {
      at: now(),
      submittedAt: pending.submittedAt,
      promptRespId: pending.promptRespId,
      resultGetAttempts: pending.resultGetAttempts,
      modelId: result.modelId || pending.modelId,
      createdTime: result.createdTime,
      files: pending.files,
      citationCount: result.citations.length,
      returnedFileNames: result.citations.map((citation) => citation.file_name),
      followUpPromptRespIds: result.followUpPromptRespIds,
      citations: result.citations.map((citation) => ({
        ...citation,
        document_hash: extractDocumentHash(citation.s3_url),
      })),
      matchedDocumentHashes: [],
      reconciledExpectedFileNames: [],
      syntheticRowIndexes: [],
    };

    const claimedHashes = new Set();

    for (const row of rows) {
      row.queryAttempts += 1;
      delete row.pendingPromptRespId;
      const { matching, groups } = groupMatchingCitations(row, result.citations);
      appendCitationEvidence(row, matching, pending.promptRespId, "requested_exact");

      if (groups.size === 0) {
        row.status = row.queryAttempts >= SETTINGS.maxQueryAttempts ? "failed" : "pending";
        addRowError(
          row,
          new KbError(
            "No citation file_name exactly equalled the expected filename after removing the confirmed agent prefix through the last '/'.",
            "NO_EXACT_MATCH",
          ),
        );
      } else {
        mergeRequestedDocuments(row, groups);
        for (const documentHash of groups.keys()) claimedHashes.add(documentHash);
      }
      row.updatedAt = now();
    }

    const allGroups = groupCitationsByHash(result.citations);
    const activePendingRowIndexes = new Set(
      state.pendingResults.flatMap((item) => item.rowIndexes || []),
    );
    const reconciliation = reconcileUnclaimedCitationGroups(
      allGroups,
      claimedHashes,
      pending.promptRespId,
      activePendingRowIndexes,
    );
    batchAudit.matchedDocumentHashes = [...claimedHashes];
    batchAudit.reconciledExpectedFileNames = reconciliation.reconciledExpectedRows.map(
      (row) => row.fileName,
    );
    batchAudit.syntheticRowIndexes = reconciliation.syntheticRows.map((row) => row.index);
    state.batches.push(batchAudit);

    state.pendingResults = state.pendingResults.filter(
      (item) => item.promptRespId !== pending.promptRespId,
    );
    persistState();

    const downloadRows = [...new Set([...rows, ...reconciliation.affectedRows])];
    for (const row of downloadRows) {
      if (stopRequested) break;
      if (row.documents.some((document) => ["pending", "downloading"].includes(document.status))) {
        await downloadPendingForRow(row);
      }
    }
  }

  async function resumePendingResult(pending) {
    const rows = rowsForPendingResult(pending);
    rows.forEach((row) => {
      row.status = "awaiting_result";
      row.pendingPromptRespId = pending.promptRespId;
      row.updatedAt = now();
    });
    persistState();

    try {
      const result = await awaitPromptResult(pending);
      await applyPromptResult(pending, result);
    } catch (error) {
      rows.forEach((row) => addRowError(row, error, "RESULT_GET_FAILED"));
      persistState();
      throw error;
    }
  }

  async function processSemanticBatch(rows) {
    const fileNames = rows.map((row) => row.fileName);
    rows.forEach((row) => {
      row.status = "querying";
      row.updatedAt = now();
    });
    persistState();

    let acknowledgement;
    try {
      acknowledgement = await submitBatchWithTransportRetries(fileNames);
    } catch (error) {
      rows.forEach((row) => {
        row.status = "pending";
        addRowError(row, error, "BATCH_SUBMIT_FAILED");
      });
      persistState();
      // A semantic miss is established only by a completed result containing
      // zero exact-match citations. Submission failures therefore halt with
      // progress saved and never consume one of the three semantic attempts.
      throw error;
    }

    const pending = registerPendingResult(rows, acknowledgement);
    await resumePendingResult(pending);
  }

  function nextBatch(eligibleRows) {
    if (!eligibleRows.length) return [];
    const minimumAttempts = Math.min(...eligibleRows.map((row) => row.queryAttempts));
    const sameRung = eligibleRows.filter((row) => row.queryAttempts === minimumAttempts);
    // After the initial batch miss, both remaining attempts are singletons.
    const size = minimumAttempts >= 1 ? 1 : SETTINGS.batchSize;
    return sameRung.slice(0, size);
  }

  async function interBatchDelay() {
    const sticky = state.meta.stickyInterBatchDelayMs || SETTINGS.minInterBatchDelayMs;
    const minimum = Math.max(SETTINGS.minInterBatchDelayMs, sticky);
    const maximum = Math.max(minimum, SETTINGS.maxInterBatchDelayMs, sticky);
    const waitMs = Math.round(minimum + Math.random() * (maximum - minimum));
    await sleep(waitMs);
  }

  async function runInternal(scopeRowCount = Infinity) {
    if (running) throw new FatalError("A KB run is already active.", "RUN_ALREADY_ACTIVE");
    if (!nativeFetch) throw new FatalError("window.fetch is unavailable.", "FETCH_UNAVAILABLE");
    if (!requestTemplate) throw new FatalError("Capture a Prompt request first.", "REQUEST_NOT_CONFIGURED");
    readBearerToken();
    getState();
    if (!outputMode) {
      throw new FatalError("Choose output with await kb.pickFolder() or kb.useBrowserDownloads().", "OUTPUT_NOT_SELECTED");
    }

    running = true;
    stopRequested = false;
    state.stopReason = null;
    persistState();
    const rowIsInScope = (row) => row.synthetic || row.index < scopeRowCount;

    try {
      // An acknowledged prompt is resumed by reissuing only its idempotent,
      // long-held result GET. Never create a new session or resubmit its POST.
      for (const pending of [...state.pendingResults].filter((item) =>
        item.rowIndexes.some((index) => index < scopeRowCount),
      )) {
        if (stopRequested) break;
        console.info(`[kb] Awaiting saved result ${pending.promptRespId} for:`, pending.files);
        await resumePendingResult(pending);
      }

      // Resume already-cited downloads before asking the model again.
      for (const row of state.rows.filter(
        (item) => rowIsInScope(item) && ["cited", "downloading"].includes(item.status),
      )) {
        if (stopRequested) break;
        await downloadPendingForRow(row);
      }

      while (!stopRequested) {
        const eligible = state.rows.filter(
          (row) =>
            rowIsInScope(row) &&
            !row.synthetic &&
            row.status === "pending" &&
            row.queryAttempts < SETTINGS.maxQueryAttempts &&
            !rowHasSavedOrExistingDocument(row),
        );
        if (!eligible.length) break;
        const batch = nextBatch(eligible);
        if (!batch.length) break;

        await interBatchDelay();
        console.info(`[kb] Querying ${batch.length} file(s):`, batch.map((row) => row.fileName));
        await processSemanticBatch(batch);
        console.table(report(false));
      }
    } catch (error) {
      state.stopReason = {
        at: now(),
        code: error.code || error.name,
        message: error.message,
        details: error.details || null,
      };
      persistState();
      console.error("[kb] Run halted cleanly; progress is saved.", error);
      throw error;
    } finally {
      running = false;
      if (stopRequested) {
        state.stopReason = { at: now(), code: "OPERATOR_STOP", message: "Stopped by operator." };
        persistState();
      }
    }

    console.info("[kb] Run pass complete. Progress is saved.");
    return report();
  }

  async function pickFolder() {
    if (typeof root.showDirectoryPicker !== "function") {
      throw new FatalError(
        "showDirectoryPicker() is unavailable or blocked. Use kb.useBrowserDownloads() for the fallback.",
        "DIRECTORY_PICKER_UNAVAILABLE",
      );
    }
    dirHandle = await root.showDirectoryPicker({ mode: "readwrite" });
    outputMode = "directory";
    console.info(`[kb] Output folder selected: ${dirHandle.name}`);
    return dirHandle.name;
  }

  function useBrowserDownloads() {
    dirHandle = null;
    outputMode = "browser";
    console.warn(
      "[kb] Browser-download fallback enabled. Disable download prompts and choose a dedicated empty folder. Disk writes cannot be verified after the click.",
    );
  }

  function stop() {
    stopRequested = true;
    console.info("[kb] Stop requested. The current network/download operation will finish before the loop exits.");
  }

  function requeueDownloadFailures() {
    if (running) throw new FatalError("Stop the active run before requeueing downloads.", "RUN_ALREADY_ACTIVE");
    let count = 0;
    for (const row of getState().rows) {
      const failedDocuments = row.documents.filter((document) => document.status === "failed");
      if (!failedDocuments.length) continue;
      for (const document of failedDocuments) {
        document.status = "pending";
        document.downloadAttempts = 0;
        document.lastError = null;
        document.updatedAt = now();
      }
      row.status = "cited";
      row.errors.push({
        at: now(),
        code: "DOWNLOAD_REQUEUED",
        message: "Download attempts were manually reset without re-querying the model.",
      });
      row.updatedAt = now();
      count += failedDocuments.length;
    }
    persistState();
    console.info(`[kb] Requeued ${count} failed document download(s). Run await kb.resume().`);
    return count;
  }

  async function backfillUnmatchedCitations() {
    if (running) throw new FatalError("Stop the active run before backfilling citations.", "RUN_ALREADY_ACTIVE");
    if (!outputMode) {
      throw new FatalError(
        "Choose output with await kb.pickFolder() or kb.useBrowserDownloads() before backfilling.",
        "OUTPUT_NOT_SELECTED",
      );
    }
    getState();
    running = true;
    stopRequested = false;

    const initialRowCount = state.rows.length;
    const reconciledRows = [];
    try {
      const historicalCitations = state.batches.flatMap((batch) =>
        Array.isArray(batch.citations)
          ? batch.citations.map((citation) => ({
              ...citation,
              sourcePromptRespId: batch.promptRespId || citation.sourcePromptRespId || null,
            }))
          : [],
      );
      const activePendingRowIndexes = new Set(
        state.pendingResults.flatMap((item) => item.rowIndexes || []),
      );
      const reconciliation = reconcileUnclaimedCitationGroups(
        groupCitationsByHash(historicalCitations),
        new Set(),
        null,
        activePendingRowIndexes,
      );
      reconciledRows.push(...reconciliation.affectedRows);
      persistState();

      const downloadRows = [...new Set([
        ...reconciledRows,
        ...state.rows.filter((row) =>
          row.documents.some((document) => ["pending", "downloading"].includes(document.status)),
        ),
      ])];
      for (const row of downloadRows) {
        if (stopRequested) break;
        await downloadPendingForRow(row);
      }

      const result = {
        syntheticRowsCreated: state.rows.slice(initialRowCount).filter((row) => row.synthetic).length,
        expectedRowsReconciled: [...new Set(
          reconciledRows.filter((row) => !row.synthetic).map((row) => row.fileName),
        )].length,
        pendingDownloads: state.rows.reduce(
          (count, row) => count + row.documents.filter((document) =>
            ["pending", "downloading"].includes(document.status),
          ).length,
          0,
        ),
      };
      console.info("[kb] Historical citation backfill complete; no Prompt request was issued.", result);
      return result;
    } finally {
      running = false;
    }
  }

  function report(log = true) {
    const current = getState();
    const counts = {};
    for (const row of current.rows) counts[row.status] = (counts[row.status] || 0) + 1;
    const result = Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => ({ status, count }));
    result.push({ status: "TOTAL", count: current.rows.length });
    if (log) {
      console.table(result);
      if (current.inputDuplicates.length) console.warn("[kb] Exact duplicate input lines (sent once):", current.inputDuplicates);
      if (current.meta.hashCollisions.length) console.warn("[kb] Cross-filename hash collisions:", current.meta.hashCollisions);
      if (current.stopReason) console.warn("[kb] Last stop reason:", current.stopReason);
    }
    return result;
  }

  function details(status = null) {
    const rows = getState().rows
      .filter((row) => !status || row.status === status)
      .map((row) => ({
        index: row.index,
        fileName: row.fileName,
        status: row.status,
        synthetic: row.synthetic === true,
        promptRespId: row.pendingPromptRespId || "",
        queryAttempts: row.queryAttempts,
        citationCount: row.citations.length,
        documentCount: row.documents.length,
        savedNames: row.documents.map((document) => document.savedName).filter(Boolean).join(" | "),
        lastError: row.errors.at(-1)?.message || "",
      }));
    console.table(rows);
    return rows;
  }

  function exportState() {
    const current = getState();
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
    const fileName = `kb-retrieval-audit-${current.agentSignature}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const saved = saveViaBrowser(fileName, blob);
    console.info(`[kb] Audit export triggered: ${saved.savedName}`);
    return saved.savedName;
  }

  function resetCurrentState(confirmation) {
    getState();
    if (confirmation !== "RESET") {
      throw new FatalError('State was not reset. Call kb.resetCurrentState("RESET") exactly.', "RESET_NOT_CONFIRMED");
    }
    root.localStorage.removeItem(stateKey);
    state = null;
    stateKey = null;
    console.warn("[kb] Current run state removed. Downloaded files were not deleted.");
  }

  function help() {
    const commands = [
      ["kb.armCopyAsFetchCapture()", "Arm capture, then paste the copied POST /api/Prompt/ fetch command."],
      ["kb.captureSummary()", "Show the sanitized captured request configuration."],
      ["kb.tokenCandidates()", "List JWT-bearing Local Storage key names only."],
      ['kb.setTokenKey("key")', "Select the token key if capture could not choose it."],
      ["await kb.pickFolder()", "Choose the verified output folder (preferred)."],
      ["kb.useBrowserDownloads()", "Use programmatic browser downloads if folder access is blocked."],
      ["await kb.pilot(20)", "Process at most the first 20 pending filenames."],
      ["await kb.run()", "Process all pending/retryable filenames."],
      ["await kb.resume()", "Resume saved downloads and queries."],
      ["kb.stop()", "Gracefully stop after the current operation."],
      ["kb.requeueDownloadFailures()", "Reset exhausted downloads after fixing output/network conditions."],
      ["await kb.backfillUnmatchedCitations()", "Download citation hashes omitted by an older saved run; never query the agent."],
      ["kb.report()", "Show status counts."],
      ['kb.details("failed")', "Show per-file details, optionally filtered by status."],
      ["kb.exportState()", "Download the complete JSON audit trail."],
      ["kb.export()", "Alias for kb.exportState()."],
    ];
    console.table(commands.map(([command, purpose]) => ({ command, purpose })));
    return commands;
  }

  const api = Object.freeze({
    version: VERSION,
    help,
    armCopyAsFetchCapture,
    cancelCapture,
    captureSummary,
    tokenCandidates: () => tokenCandidates(),
    setTokenKey,
    pickFolder,
    useBrowserDownloads,
    pilot: (count = 20) => runInternal(count),
    run: () => runInternal(Infinity),
    resume: () => runInternal(Infinity),
    stop,
    requeueDownloadFailures,
    backfillUnmatchedCitations,
    report,
    details,
    exportState,
    export: exportState,
    resetCurrentState,
    _test: Object.freeze({
      resultTimeoutMs: SETTINGS.resultTimeoutMs,
      parseFileNames,
      returnedFileIdentity,
      isExactFileMatch,
      buildPrompt,
      parseSessionId,
      parsePromptAck,
      parsePromptResult,
      summarizePromptEnvelope,
      extractDocumentHash,
      resultUrl,
      sanitizeCapturedRequest,
      fnv1a,
    }),
  });

  root.kb = api;
  console.info(`[kb] KB Retrieval Harness v${VERSION} loaded. Run kb.help().`);
})();
