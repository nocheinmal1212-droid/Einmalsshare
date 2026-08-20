# Transport Contract — OBSERVED (supersedes all prior assumptions)

Derived from a complete captured request lifecycle, not inference. Where this
document conflicts with earlier specs, **this document wins**.

---

## Critical corrections to the previous spec

| # | Prior belief | Reality | Impact |
|---|---|---|---|
| 1 | `GET /api/PromptResponse/{id}` | **`GET /api/PrompResponse/{id}`** — the API path is misspelled server-side, missing the `t` | Every request 404s. Copy literally; never "fix" it |
| 2 | Response is synchronous | POST is an ack (~0.2s); result comes from a separate GET held open ~65s | Full architecture change |
| 3 | `data` shape is uniform | POST → `data` is an **array**; PrompResponse → `data` is an **object** | Caused the observed SchemaError |
| 4 | `file_name` may carry a prefix | It **does**: `"Assurance Knowledge Agent/FILE.pdf"` | Prefix-stripping mandatory |
| 5 | `page_no` is a scalar | It is a **list**: `[2]` | URL index = `page_no[0] - 1` |
| 6 | `index` is an integer | It is a **string**: `"[1] "` (brackets, trailing space) | Do not parse as int |

---

## Endpoint sequence

```
GET  /api/Tools/GetSessionId      ~0.02s   new conversation; returns session UUID
POST /api/Prompt/CheckDuplicate   ~0.03s   OPTIONAL — skip it
POST /api/Prompt/                 ~0.2s    returns prompt_resp_id
GET  /api/PrompResponse/{R-ID}    ~59-65s  blocks until ready; carries citations
GET  /api/Prompt/GetHistory/2     ~0.07s   UI sidebar only — skip it
GET  /api/Citation/GetFile/...    ~0.05s   the PDF
```

Observed waits: 65.5s and 58.6s across two captures. The operator reports up to
2–4 minutes. **Set the GET timeout to 5 minutes.**

---

## 0. New conversation — `GET /api/Tools/GetSessionId`

Auth: **Bearer** (preflight requests `authorization`). Response:

```json
{ "success": true, "ret_msg": "", "data": "<uuid>" }
```

`data` is a **bare UUID string**, not an object or array.

**Linkage confirmed by observation:** the UUID returned here appears verbatim as
`model_params.user_session_id` in the subsequent `POST /api/Prompt/`. Two
consecutive calls yield distinct UUIDs, so this is the conversation-isolation
mechanism.

Harness flow per batch: call `GetSessionId`, take `data`, write it into the
captured payload template's `model_params.user_session_id`, leaving
`data_source_id` and `prompt_persona_id` untouched.

---

## 1. Submit — `POST /api/Prompt/`

Request body (reuse the captured template verbatim; substitute `content` only):

```json
{
  "list_model_id": ["clara"],
  "content": "<the mature prompt>",
  "model_params": {
    "data_source_id":  "<uuid>",
    "prompt_persona_id": "<uuid>",
    "user_session_id":   "<uuid>"
  }
}
```

Response — note `data` is an **array**:

```json
{
  "success": true,
  "ret_msg": "",
  "data": [{
    "prompt_resp_id": "R00116885",
    "model_id": "clara",
    "description": "KPMG China Audit Chat",
    "error_message": ""
  }]
}
```

Extract: `data[0].prompt_resp_id`. Abort the batch if `success !== true`,
surfacing `ret_msg` and `data[0].error_message`.

## 2. Await result — `GET /api/PrompResponse/{prompt_resp_id}`

Single long-held request. **No polling loop.** Response — `data` is an **object**:

```json
{
  "success": true,
  "ret_msg": "",
  "data": {
    "prompt_resp_id": "R00116885",
    "model_id": "clara",
    "content":  "<the prompt echoed back>",
    "message":  "<the model's text answer>",
    "created_time": "2026-08-20 09:14:11",
    "list_page_info": [
      {
        "index": "[1] ",
        "file_name": "Assurance Knowledge Agent/GAAM_Alert_2025_31_Attachment_2.pdf",
        "page_no": [2],
        "s3_url": "https://<api-host>/api/Citation/GetFile/<hash>.pdf/1"
      }
    ],
    "list_suggestion": [],
    "follow_up_prompt_resp_ids": [],
    "score": null,
    "comment": null
  }
}
```

There is **no status/pending field**. Completion is implied by the response
returning at all. Treat missing `list_page_info` as "no citations", which marks
the batch's files unmatched — not as a fatal schema error.

**On timeout or disconnect: re-issue the GET with the same `prompt_resp_id`.**
Do NOT resubmit the prompt. The result is stored server-side, so a re-GET is
cheap, idempotent, and gives free resumability.

Log `follow_up_prompt_resp_ids` if ever non-empty — long answers may chain.

## 3. Download — `GET` the `s3_url` verbatim

`s3_url` is an absolute URL including host. Use it exactly as returned; never
reconstruct it. The trailing segment is `page_no[0] - 1`.

Response: `application/pdf`, `Content-Length` present, **no `Content-Disposition`**.

---

## Authentication — three distinct profiles

Recovered from CORS preflight `access-control-request-headers`:

| Endpoint | Auth |
|---|---|
| `POST /api/Prompt/CheckDuplicate` | `authorization`, `content-type` |
| `POST /api/Prompt/` | `authorization`, `content-type` |
| `GET /api/PrompResponse/{id}` | `authorization` |
| `GET /api/Prompt/GetHistory/{n}` | `authorization` |
| `GET /api/Citation/GetFile/...` | **no preflight → cookies only, no Bearer** |

Server returns `access-control-allow-credentials: true` and an `allow-origin`
pinned to the app origin. Therefore:

- All requests must originate from the **app page**, not the API origin.
- Use `credentials: "include"` everywhere.
- Send `Authorization: Bearer <token>` on the three JSON endpoints, rebuilt from
  Local Storage immediately before each request.
- Send **no** `Authorization` header on the download — adding one triggers a
  preflight the endpoint does not answer.

---

## Matching rule (unchanged in intent, sharpened by evidence)

1. Take `file_name`, strip everything up to and including the **last** `/`.
2. Compare to the requested filename with **case-sensitive exact equality**.
   No lowercasing, no trimming, no substring, no fuzzy matching.
3. Zero matches for a requested file → that file is unmatched; requeue it.
   Other files in the same batch still succeed independently.
4. Group matches by the `<hash>` path segment of `s3_url`; download once per
   distinct hash. Two entries differing only in trailing page index are the
   same document.
5. If one exact filename maps to more than one hash → `ambiguous`; save all
   candidates for review.
6. If one hash maps to two different exact filenames → flag; do not merge.

The live trace contains `..._Attachment_2.pdf` and `..._Attachment_3.pdf`
alongside sibling documents. Substring matching would silently cross-assign
these. Exact equality is not optional.

---

## Endpoints to skip

- **`CheckDuplicate`** — a UI convenience that returns prior prompts with
  identical text. Confirmed optional: the pilot harness omitted it and the POST
  still succeeded. Uses `list_provider_id`, not `list_model_id`.
- **`GetHistory/{n}`** — populates the UI sidebar. Irrelevant.

---

---

## Non-determinism across runs — observed, and it matters

The identical prompt submitted twice to the same agent produced:

| Aspect | Run 1 | Run 2 | Stable? |
|---|---|---|---|
| Cited filenames | same 4 | same 4 | yes |
| `page_no` for `..._Attachment_3.pdf` | `[2]` → `.pdf/1` | `[1]` → `.pdf/0` | **NO** |
| Document hash + byte size | `235736` | `235736` | yes |
| `message` prose format | `-> 2025 - 09 cite [1]` | `-> 2025 - 09 [1]` | **NO** |

Consequences:

- **Dedupe on the hash segment, never the full `s3_url`.** The trailing page
  index varies run to run for the same document.
- **Never cache a full URL across runs**, but a re-GET within a run is safe —
  document hashes are stable across sessions.
- **Never parse the `message` field.** The model's output formatting is not
  reproducible. `list_page_info` is the sole authoritative source; the prose is
  for human reading only.

---

## Still unobserved

1. **401 / 429 response shapes.** Handle defensively: on 401, re-read the token
   and retry once, then halt; on 429, honour `Retry-After` if present.
2. **Behaviour past ~65s.** Two samples, both under 66s. If an intermediary
   kills a longer connection, re-GET the same `prompt_resp_id` rather than
   resubmitting.
