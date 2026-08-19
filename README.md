# KB Retrieval Harness

This package contains a browser-console harness for sequentially retrieving cited knowledge-base PDFs through an authenticated Microsoft Edge session. It processes four exact filenames per prompt, creates a fresh conversation for every batch, downloads successful citations immediately, and persists a per-file audit trail.

The harness never stores or prints the Bearer-token value. It reads the configured Local Storage key immediately before every authenticated request. Prompt and session requests use Bearer authentication plus `credentials: "include"`; citation downloads deliberately use cookies only.

## Files

- `kb-retrieval-harness.js` — paste/run this as an Edge DevTools Snippet.
- This runbook — setup, pilot, recovery, and reconciliation instructions.

## Prepare the script

Open `kb-retrieval-harness.js` and find `FILE_NAMES_TEXT` near the top. For this run, include only the filenames assigned to the agent that the operator will select. Replace the placeholder with one bare filename per line:

```js
const FILE_NAMES_TEXT = String.raw`
UN_GAAM_ALERT_2025_31.pdf
GAAM_Alert_2025_31_Attachment_1.pdf
`;
```

Paste names at column 1 without bullets, quotes, commas, agent prefixes, or surrounding whitespace. Exact duplicate lines are sent only once and listed in the audit. The script rejects path-like or whitespace-padded input instead of silently changing it.

Matching is case-sensitive exact equality after one narrowly defined operation: an optional agent/path prefix is removed from the returned `file_name`. Nothing else is normalized. In particular, the harness does not lowercase, trim, use substrings, remove attachment suffixes, or perform fuzzy matching.

## Capture the selected agent’s request template

Do this once for each selected agent/configuration:

1. On the corporate device, open the authenticated application in Edge.
2. Select the agent and open a fresh conversation.
3. Send one throwaway query.
4. In DevTools Network, select its `POST /api/Prompt/` request and choose **Copy as fetch**.
5. In DevTools Sources, create a Snippet, paste the complete harness into it, and run it.
6. In the Console, run:

   ```js
   kb.armCopyAsFetchCapture()
   ```

7. Paste the unedited **Copy as fetch** command and press Enter.

The harness intercepts that pasted command, extracts the URL, headers, and agent-specific payload, removes the Bearer value, and does **not** resend the throwaway request. Unrelated background fetches are passed through normally.

Check the sanitized result:

```js
kb.captureSummary()
```

If the token’s Local Storage key could not be selected uniquely:

```js
kb.tokenCandidates()       // key names only; never token values
kb.setTokenKey("exact-key-name")
```

The sanitized request template is saved in Local Storage for recovery after a reload. Capturing a different agent/configuration produces a separate state namespace.

## Select the output

Preferred, because the harness can verify existing files and avoid overwriting different content:

```js
await kb.pickFolder()
```

If managed policy blocks the directory picker, configure Edge to download without prompting into a dedicated empty folder, then use:

```js
kb.useBrowserDownloads()
```

Browser-download mode verifies the HTTP response and PDF bytes before clicking the download, but cannot verify the final disk write. Its rows are reported as `download_triggered`, not `downloaded`.

## Pilot, then run

Keep the application tab in the foreground and prevent the corporate Mac from sleeping (`caffeinate -dims` if permitted).

Run the first 20 input rows through their complete retry ladder:

```js
await kb.pilot(20)
kb.report()
kb.details()
kb.exportState()
```

Inspect the downloaded files and audit before continuing. Then run the remainder:

```js
await kb.run()
```

Each semantic attempt performs the following sequence:

1. Read the current Bearer token.
2. `GET /api/Tools/GetSessionId` and validate the returned raw string or object `data` field.
3. Copy the captured Prompt payload and replace only `content` and `model_params.user_session_id`.
4. Submit up to four filenames.
5. Compare returned citation names by case-sensitive exact equality after optional path-prefix removal.
6. Group cited pages by the existing `/getfile/<hash>/` path segment without reconstructing any URL.
7. Download one verbatim URL per matching filename/hash immediately, using cookies and no Bearer header.
8. Verify `application/pdf`, byte length, PDF signature, and SHA-256 before saving.

Partial batches are safe: matched files are saved, while only unmatched filenames requeue. The initial and second semantic attempts use batches of up to four; the third and final attempt is a singleton. Every attempt and every transport retry gets a fresh conversation.

Network and server failures during Prompt submission are retried in fresh conversations. Citation downloads are retried up to two additional times, except `403`, which is recorded as unavailable without probing alternate identifiers.

## Controls and recovery

```js
kb.stop()                   // graceful stop after the current operation
await kb.resume()           // continue saved downloads and pending queries
kb.requeueDownloadFailures() // after fixing folder/network issues; then resume
kb.report()                 // counts by per-file status
kb.details("failed")       // optional status filter
kb.exportState()            // complete JSON audit trail
kb.help()                   // command summary
```

State is rewritten in Local Storage after material transitions. After a page reload:

1. Rerun the DevTools Snippet.
2. Reselect the output folder with `await kb.pickFolder()` (directory handles are intentionally not persisted), or re-enable browser-download mode.
3. Run `await kb.resume()`.

A `401` is retried once after rereading Local Storage. A second `401` halts cleanly. A `429` honors `Retry-After` when present, otherwise backs off for 30, 60, 120, and 240 seconds while increasing the inter-batch delay. Unexpected response structure halts the run rather than silently accepting incomplete data.

To remove only the current run’s saved state (downloaded files are not touched):

```js
kb.resetCurrentState("RESET")
```

## Audit interpretation

- `downloaded` — PDF response verified and disk write completed through the directory API.
- `download_triggered` — PDF response verified; browser download was triggered but its disk write cannot be inspected.
- `pending` — waiting for another semantic attempt.
- `failed` — no exact citation match after three semantic attempts, or transport attempts were exhausted.
- `cited` — exact citation found; a download remains retryable.
- `download_failed` — all configured download attempts were exhausted.
- `unavailable` — the immediate citation download returned `403`.
- `ambiguous` — the exact filename resolved to more than one distinct document hash. Every candidate was saved with a deterministic suffix for review.

Page-level citations with the same exact filename and document hash are downloaded once. Hashes are **not** used to merge different filenames: if a hash appears under two distinct exact names, both identities are preserved and the collision is flagged for review. This protects parent and attachment filenames from accidental conflation.

The exported JSON records every returned citation candidate, exact matches, page URLs, document hashes, download checks, errors, duplicate input lines, and cross-filename hash collisions. Reconcile that export against the operator’s source list after each agent run.
