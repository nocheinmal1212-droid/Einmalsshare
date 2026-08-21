# KB 检索工具（KB Retrieval Harness）

> **TLDR**

## **重要**

1. 不需要看“试点，然后运行” block之后的内容如果只是随意使用
2. 以英文文件为准。中文是机翻的产品。
3. 如果对devtools不熟悉，操作细节请问AI。
4. 以下介绍白话流程。

## **白话流程**

1. 打开浏览器，右键点inspect打开devtools
2. 找到network，点左上角的一个按键清空它的log，建议打开preserve logs
3. 找到sources，在sources里找到snippet，创建新的snippet
4. 把harness的代码复制黏贴进去
5. 把harness代码最上面  const FILE_NAMES_TEXT = String.raw`
PASTE_ONE_EXACT_FILENAME_PER_LINE_HERE.pdf
`;的部分PASTE_ONE_EXACT_FILENAME_PER_LINE_HERE.pdf拷贝进去你的文件名。
6. 点击最下面的小三角开始运行
7. 找到console，点进去
8. 如果没法复制黏贴可能第一次需要打allow paste，具体信息看console提示
9. 输入kb.armCopyAsFetch()。输入方法：打前面，打tab会自动帮你完成。需要自己手打括号。
10. 注意：本工具有记忆功能。如果想要freshrerun，使用kb.resetCurrentState("RESET")指令。
11. 回到你的network。
12. 此步骤任意时候执行都可以，但是确保你的剪贴板里有：向这个AI agent输入一个随便的prompt，例如hello world。在你的network里找到prompt/，注意status是200不是204.可以查看payload里面的content部分是不是你的信息来确认。右键这个prompt/，选择copy -> copy as fetch.
13. 黏贴。你的初始化已经完成。我们的harness已经拿到了你的agent spec。

14. 输入await kb.pickFolder().
15. 你的浏览器会给你一个选择。选你的folder。注意第一次使用可能会需要allow来给它access。
16. 输入await kb.pilot(随便输个数字，多大都行)
17. 如果没有bug就开始运行。如果没有bug就查看报错信息。如果报错信息看不懂或遇到了没有可读报错信息的edge case请根据TRUST_ME_BRO principle全部重来一遍。
18. 运行 await kb.run()跑完你的全部file。

18. 常见问题：
- a. 你的步骤执行有问题。
- b. 如果遇到了你经常只有一个query，你大概率是agent问错了。
- c. file list贴入需要保证没有空行，一行一个。修改源代码后需要重新运行，重走一遍流程。

   注意：harness对特定的list是有记忆的。重跑的时候建议在最开始运行kb.resetCurrentState("RESET")。




## **以下是正式的manual**

## 文件

- `kb-retrieval-harness.js` — 将此文件作为 Edge DevTools 代码段粘贴/运行。
- 本操作手册 — 包含设置、试点、恢复和核对说明。

## 准备脚本

打开 `kb-retrieval-harness.js`，在顶部附近找到 `FILE_NAMES_TEXT`。本次运行仅包含操作员将选择的代理所分配的文件名。将占位符替换为每行一个纯文件名：

```js
const FILE_NAMES_TEXT = String.raw`
UN_GAAM_ALERT_2025_31.pdf
GAAM_Alert_2025_31_Attachment_1.pdf
`;
```

在第一列粘贴名称，不带项目符号、引号、逗号、代理前缀或周围空白。完全相同的重复行仅发送一次，并列入审计。脚本会拒绝包含路径或空白填充的输入，而不是静默更改它。

匹配是区分大小写的精确相等，仅经过一次狭义定义的操作：通过返回的 `file_name` 中**最后一个正斜杠**去除已确认的代理前缀。除此之外不做任何规范化。特别地，该工具不会转小写、修剪、将反斜杠视为分隔符、使用子字符串、删除附件后缀或执行模糊匹配。

## 捕获所选代理的请求模板

每个选定代理/配置执行一次：

1. 在公司的 Windows 设备上，在 Edge 中打开已认证的应用程序。
2. 选择代理并打开全新对话。
3. 发送一次测试查询。
4. 按 **F12** 或 **Ctrl+Shift+I** 打开 DevTools。在 Network 中，选择其 `POST /api/Prompt/` 请求，然后选择 **Copy as fetch**。
5. 在 DevTools 的 Sources 中，创建一个 Snippet，粘贴完整的工具代码，按 **Ctrl+S** 保存，然后按 **Ctrl+Enter** 运行。
6. 在控制台中运行：

   ```js
   kb.armCopyAsFetchCapture()
   ```

7. 粘贴未编辑的 **Copy as fetch** 命令并按 Enter。

该工具会拦截粘贴的命令，提取 URL、headers 和代理特定的 payload，移除 Bearer 值，并且**不会**重新发送测试请求。无关的后台 fetch 调用则正常通过。

检查脱敏后的结果：

```js
kb.captureSummary()
```

如果无法唯一选择 token 的 Local Storage 键：

```js
kb.tokenCandidates()       // 仅显示键名，绝不显示 token 值
kb.setTokenKey("exact-key-name")
```

脱敏后的请求模板保存在 Local Storage 中，以便重新加载后恢复。捕获不同的代理/配置将产生独立的状态命名空间。

## 选择输出目录

推荐方式（因为工具可以验证现有文件并避免覆盖不同内容）：

```js
await kb.pickFolder()
```

如果托管策略阻止目录选择器，请将 Edge 配置为无提示下载到专用空文件夹中，然后使用：

```js
kb.useBrowserDownloads()
```

浏览器下载模式在点击下载前验证 HTTP 响应和 PDF 字节，但无法验证最终磁盘写入。其行状态报告为 `download_triggered`，而非 `downloaded`。

## 试点，然后运行

保持应用程序标签页在前台。在 Windows **设置 → 系统 → 电源和电池 → 屏幕和睡眠**中，如果公司策略允许，请在运行期间阻止睡眠（插电时）。

对前 20 个输入行执行完整的重试阶梯：

```js
await kb.pilot(20)
kb.report()
kb.details()
kb.exportState()
```

在继续之前检查下载的文件和审计。然后运行剩余部分：

```js
await kb.run()
```

根据观察，每个模型结果耗时 2–4 分钟，一个干净的 20 文件试点（五个四文件批次）大约需要 10–20 分钟。不匹配文件的重试会增加额外时间。


## 控制与恢复

```js
kb.stop()                    // 在当前操作完成后优雅停止
await kb.resume()            // 首先恢复已保存的结果 GET，然后继续下载/查询
kb.requeueDownloadFailures() // 修复文件夹/网络问题后；然后 resume
await kb.backfillUnmatchedCitations() // 从 v1.1.0 审计中恢复丢失的引用 URL；不调用 Prompt
kb.report()                  // 按每个文件状态计数
kb.details("failed")         // 可选状态筛选
kb.details("extra")          // 未匹配的下载引用及保存的文件名
kb.exportState()             // 完整的 JSON 审计跟踪
kb.help()                    // 命令摘要
```

状态在每次实质性转换后都会被重写至 Local Storage。页面重新加载后：

1. 重新运行 DevTools 代码段。
2. 使用 `await kb.pickFolder()` 重新选择输出文件夹（目录句柄有意不持久化），或重新启用浏览器下载模式。
3. 运行 `await kb.resume()`。

在将此版本替换 v1.1.0 后，请在选择输出文件夹后、恢复代理工作负载之前运行以下命令一次：

```js
await kb.backfillUnmatchedCitations()
```

该命令仅读取 `state.batches[].citations`，核对或创建缺失的文档行，并下载它们，而无需创建会话或发出 Prompt。多次调用和重新加载均保持幂等。

状态迁移还会将 v1.1.0 的重试历史转换到新的阶梯上。第一个已完成的结果仍作为批次尝试；仅后续的单文件结果消耗两个单文件重试槽位。因此，之前 `failed` 的行（曾具有批次→批次→单文件历史）将重新打开一次最终的单文件尝试。

如果 Prompt 确认已经收到，恢复操作会在提交任何新内容之前重新发起 `/api/PrompResponse/{saved-id}`。保存的 ID 使恢复操作廉价且幂等。`kb.stop()` 是优雅的，不会中止进行中的结果 GET，因此可能最多需要当前请求的五分钟超时时间才返回。

`401` 在重新读取 Local Storage 后重试一次。第二次 `401` 会干净停止。`429` 会尊重 `Retry-After`（若存在），否则按 30、60、120、240 秒退避，同时增加批次间延迟。每个端点都有其自己的严格响应解析器；意外结构会停止运行，而不是静默接受不完整数据。

仅删除当前运行保存的状态（已下载文件不受影响）：

```js
kb.resetCurrentState("RESET")
```

恢复和重新加载恢复属于同一运行，并且可以重用已保存的引用 URL。若要使用相同的代理和文件名列表有意启动一个新的独立运行，请先导出旧审计并重置其状态。新运行随后查询新的 URL；完整引用 URL 永远不会从一次独立运行带入另一次。

## 审计状态说明

- `downloaded` — PDF 响应已验证，并通过目录 API 完成磁盘写入。
- `download_triggered` — PDF 响应已验证；已触发浏览器下载，但无法检查其磁盘写入。
- `pending` — 等待另一次语义尝试。
- `awaiting_result` — Prompt 已被接受，其保存的 `prompt_resp_id` 正在等待，或已准备好通过长时间持有的结果 GET 恢复。
- `failed` — 在初始批次加上两次单文件结果后仍未找到精确引用匹配。
- `cited` — 找到精确引用；下载仍可重试。
- `download_failed` — 所有配置的下载尝试已用完。
- `unavailable` — 立即引用下载返回 `403`。
- `ambiguous` — 精确文件名解析为多个不同的文档哈希。每个候选均以确定性后缀保存以供审查。
- `extra` — 已验证的合成下载，对应一个无法与任何可用预期行匹配的引用哈希。其输出名称以 `unmatched__` 开头。

具有相同文档哈希的页面级引用在整个运行中仅下载一次。精确文件名身份保持独立：当一个哈希出现在不同名称下时，两个身份均保留在审计中，并标记跨文件名冲突，而后续文档记录将重用已验证的下载，而不再获取。这可以保护父文件和附件文件名免于意外混淆。

导出的 JSON 记录每个返回的引用候选、精确匹配、页面 URL、文档哈希、下载校验、错误、重复输入行以及跨文件名哈希冲突。每次代理运行后，将该导出与操作员的源列表进行核对。

可选的 Windows 手动摘要比较：

```powershell
certutil -hashfile "C:\path\to\file.pdf" SHA256
```


以下是original：

# KB Retrieval Harness

This package contains a browser-console harness for sequentially retrieving cited knowledge-base PDFs through an authenticated Microsoft Edge session. It processes four exact filenames per prompt, creates a fresh conversation for every batch, downloads successful citations immediately, and persists a per-file audit trail.

The harness never stores or prints the Bearer-token value. It reads the configured Local Storage key immediately before every authenticated request. Session, Prompt-acknowledgement, and Prompt-result requests use Bearer authentication plus `credentials: "include"`; citation downloads deliberately use cookies only.

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

Matching is case-sensitive exact equality after one narrowly defined operation: the confirmed agent prefix is removed through the **last forward slash** in the returned `file_name`. Nothing else is normalized. In particular, the harness does not lowercase, trim, treat backslashes as separators, use substrings, remove attachment suffixes, or perform fuzzy matching.

## Capture the selected agent’s request template

Do this once for each selected agent/configuration:

1. On the corporate Windows device, open the authenticated application in Edge.
2. Select the agent and open a fresh conversation.
3. Send one throwaway query.
4. Open DevTools with **F12** or **Ctrl+Shift+I**. In Network, select its `POST /api/Prompt/` request and choose **Copy as fetch**.
5. In DevTools Sources, create a Snippet, paste the complete harness, save with **Ctrl+S**, and run with **Ctrl+Enter**.
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

Keep the application tab in the foreground. In Windows **Settings → System → Power & battery → Screen and sleep**, prevent sleep while plugged in for the duration of the run, if corporate policy permits.

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

At the observed 2–4 minutes per model result, a clean 20-file pilot (five four-file batches) takes roughly 10–20 minutes. Unmatched-file retries add time.

Each semantic attempt performs the following sequence:

1. Read the current Bearer token.
2. `GET /api/Tools/GetSessionId` and validate `{ success: true, data: "<session UUID>" }`.
3. Copy the captured Prompt payload and replace only `content` and `model_params.user_session_id`.
4. `POST /api/Prompt/` with up to four filenames; parse its array acknowledgement and persist `data[0].prompt_resp_id` immediately.
5. Issue one blocking, Bearer-authenticated `GET /api/PrompResponse/{prompt_resp_id}`. The missing **t** in `PrompResponse` is the deployed API path and must remain unchanged.
6. Wait up to five minutes for the result object. The harness never parses its nondeterministic `message`; `list_page_info` is authoritative.
7. Compare returned citation names by case-sensitive exact equality after removing the confirmed prefix through the last `/`.
8. Group cited pages by the existing `/getfile/<hash>/` path segment without reconstructing any URL. `index` remains a string and `page_no` remains an array.
9. Download one verbatim URL per matching filename/hash immediately, using cookies and no Bearer header.
10. Verify `application/pdf`, byte length, PDF signature, and SHA-256 before saving.

Partial batches are safe: matched files are saved, while only unmatched filenames requeue. A successful result with missing or null `list_page_info` means zero citations, so those files requeue normally. The initial and second semantic attempts use batches of up to four; the third and final attempt is a singleton.

Network and server failures before a Prompt acknowledgement are retried in fresh conversations. After an acknowledgement, timeout, disconnect, or server failure reissues only the result GET with the **same** saved `prompt_resp_id`; it never resubmits the Prompt and consumes no semantic attempt. Citation downloads are retried up to two additional times, except `403`, which is recorded as unavailable without probing alternate identifiers.

## Controls and recovery

```js
kb.stop()                    // graceful stop after the current operation
await kb.resume()            // resume saved result GETs first, then downloads/queries
kb.requeueDownloadFailures() // after fixing folder/network issues; then resume
kb.report()                  // counts by per-file status
kb.details("failed")        // optional status filter
kb.exportState()             // complete JSON audit trail
kb.help()                    // command summary
```

State is rewritten in Local Storage after material transitions. After a page reload:

1. Rerun the DevTools Snippet.
2. Reselect the output folder with `await kb.pickFolder()` (directory handles are intentionally not persisted), or re-enable browser-download mode.
3. Run `await kb.resume()`.

If a Prompt acknowledgement had already been received, resume reissues `/api/PrompResponse/{saved-id}` before submitting anything new. The saved ID makes recovery cheap and idempotent. `kb.stop()` is graceful and does not abort an active result GET, so it may take up to the current request’s five-minute timeout to return.

A `401` is retried once after rereading Local Storage. A second `401` halts cleanly. A `429` honors `Retry-After` when present, otherwise backs off for 30, 60, 120, and 240 seconds while increasing the inter-batch delay. Each endpoint has its own strict response parser; unexpected structure halts the run rather than silently accepting incomplete data.

To remove only the current run’s saved state (downloaded files are not touched):

```js
kb.resetCurrentState("RESET")
```

Resume and reload recovery belong to the same run and may reuse its saved citation URLs. To deliberately start a new independent run with the same agent and filename list, export the old audit and reset its state first. The new run then queries fresh URLs; full citation URLs are never carried from one independent run into another.

## Audit interpretation

- `downloaded` — PDF response verified and disk write completed through the directory API.
- `download_triggered` — PDF response verified; browser download was triggered but its disk write cannot be inspected.
- `pending` — waiting for another semantic attempt.
- `awaiting_result` — Prompt was accepted and its saved `prompt_resp_id` is waiting on, or ready to resume through, the long-held result GET.
- `failed` — no exact citation match after three semantic attempts, or transport attempts were exhausted.
- `cited` — exact citation found; a download remains retryable.
- `download_failed` — all configured download attempts were exhausted.
- `unavailable` — the immediate citation download returned `403`.
- `ambiguous` — the exact filename resolved to more than one distinct document hash. Every candidate was saved with a deterministic suffix for review.

Page-level citations with the same exact filename and document hash are downloaded once. Hashes are **not** used to merge different filenames: if a hash appears under two distinct exact names, both identities are preserved and the collision is flagged for review. This protects parent and attachment filenames from accidental conflation.

The exported JSON records every returned citation candidate, exact matches, page URLs, document hashes, download checks, errors, duplicate input lines, and cross-filename hash collisions. Reconcile that export against the operator’s source list after each agent run.

For an optional manual Windows digest comparison:

```powershell
certutil -hashfile "C:\path\to\file.pdf" SHA256
```
