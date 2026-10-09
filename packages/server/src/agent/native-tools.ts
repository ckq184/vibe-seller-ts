// 原生 ToolPort（Phase 5.1）：进程内替换 Python MCP 子进程，逐语义移植原
// app/mcp_server.py（390 行，纯 HTTP loopback 代理）。
//
// 与原实现的同构关系（改动处逐一注明）：
//   - 22 个工具 schema = app/mcp_tool_schemas.py + app/mcp_ad_tool_schemas.py 的
//     ast 抽取（test/fixtures/mcp-tools.json 为对账钉子），description 全文逐字
//     保留——那是每次决策都在模型上下文中的审计契约。generate_image 的两个动态位
//     （模型 enum / 指导语）原文件在 import 时由 vision catalog 派生
//     （mcp_tool_schemas.py:17-29），这里改为 buildNativeToolSchemas() 显式注入。
//   - 执行器 = handle_tool_call 的 dispatch + call_api：进程内 app.request 自调
//     替代 httpx loopback（PRD §6.2 预裁决）。同 auth 判定树、同错误形状、同 SSE
//     侧效应、同遥测接线——因为打的就是同一个 Hono app。
//   - 请求身份（实读裁决）：原 claude_backend.py:498-545 注册 MCP 时签发 7 天服务
//     令牌（role='ai_bot' 的用户优先，否则 ('system','admin')；SERVICE_TOKEN_EXPIRE
//     =7d，auth.py:29）；mcp_server.py:82-83 把令牌作为 **cookie auth_token** 附带，
//     不是 Bearer 头——PRD §3.2"Bearer 头"与原实现冲突，以原实现为准（TS auth 的
//     tokenFromRequest cookie 优先、Bearer 回退，两者判定等价）。
//   - 错误包装：工具执行失败 → 成功结果 content 里的单键 {"error": str(e)}，不是
//     协议层 error（原 :307-308）；对 ToolCallResult 的判别与
//     packages/bridge/src/mcp.ts:138-151（原 MCP stdio 客户端）逐字一致。
//   - 已知差异（均注释在点）：进程内自调没有 httpx 的 60s 转发超时层（原 :66 默认
//     timeout=60）——该超时只作用于 loopback 转发，不作用于 server handler 本身，
//     进程内等价于 handler 自身时长，generate_image 的"无超时等人工确认"语义由此
//     天然满足；HTTP 状态码不判（原 call_api 无 raise_for_status，4xx/5xx 的
//     {"detail": …} 按成功结果透出）；缺参错误文案取运行时原生消息
//    （Python str(KeyError('x')) == "'x'"，这里按同字面量复刻）。

import type { ToolCallResult, ToolIntent, ToolPort } from "@vibe/core";
import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { createSessionToken, SERVICE_TOKEN_EXPIRE_SECONDS } from "../jwt";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// 原 mcp_tool_schemas.py 在模块加载时用占位物拼好 enum/指导语；抽取器在 schema 里
// 留下哨兵（enum 占位 "<<MODEL_IDS>>"、指导语占位 <<MODEL_GUIDE>>，前者由
// buildNativeToolSchemas() 整组替换 enum 数组，后者做字符串替换）。
const MODEL_GUIDE_PLACEHOLDER = "<<MODEL_GUIDE>>";

// ── 生成段：由 test/fixtures/mcp-tools.json 生成（ast 抽取自原 Python），勿手改 ──
export const MCP_TOOL_SCHEMAS: McpToolDef[] = [
 {
  "name": "vibe_seller_declare_ad_task",
  "description": "Advertising work only. BEFORE opening a browser or reading any ad data, declare what this phase of the task is for. The declaration decides how much the completeness gate asks of you and whether the user gets a review console — so a narrow request stays narrow instead of being expanded into a whole-store audit. Declaring is required: an ad report with no declaration is refused.\n\nDeclare ONCE per user turn, before browsing. Within that turn you may call it again for exactly two reasons: to NARROW (same kind, same combos, plus a `campaigns` list you could only learn by enumerating the account), or to correct kind=\"investigate\" to kind=\"audit\" when the work turned out to produce decisions (same combos or fewer, same campaigns or fewer). You cannot add a marketplace, widen the campaign list, or move to a kind that owes LESS than the one you declared. If the user later sends another message that changes what you are doing (e.g. \"now audit the ads for the listing you just created\"), declare again for that new phase — the scope may name campaigns you created earlier.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "kind": {
     "type": "string",
     "enum": [
      "audit",
      "create",
      "execute",
      "investigate"
     ],
     "description": "audit = judge existing ads and recommend changes (this is the only kind that opens the review console). create = build new campaigns. execute = apply changes the user already approved. investigate = answer a question, change nothing. \n\nNUMBERS OR CHANGES is the line between investigate and audit, and it decides more than any other field here. If what they want back is a FIGURE — what did we spend, what is our ROAS, how did last month go — that is `investigate`, however many marketplaces it spans: you are reading, not proposing. If they want to know what to CHANGE, asked you to review/check something, or asked \"is this right?\", that is `audit`, and it is what gives them a console to approve your recommendations line by line. \"Review the bids on <campaign>\" is an audit. When you cannot tell, ask yourself whether your answer will contain a recommendation; if it will, declare `audit`. \n\nThere is no \"edit\": a request to change a few bids is an AUDIT whose scope names those campaigns."
    },
    "scope": {
     "type": "object",
     "description": "What the user actually asked about. OMIT `combos` ONLY when they asked about the whole store — an absent combo list means every marketplace, and you will be held to all of them.",
     "properties": {
      "combos": {
       "type": "array",
       "description": "Marketplaces in scope, e.g. [{\"platform\":\"amazon\",\"country\":\"AE\"}].",
       "items": {
        "type": "object",
        "properties": {
         "platform": {
          "type": "string"
         },
         "country": {
          "type": "string"
         }
        },
        "required": [
         "platform",
         "country"
        ]
       }
      },
      "campaigns": {
       "type": "array",
       "items": {
        "type": "string"
       },
       "description": "Campaign ids in scope. Omit to mean every campaign in the combos above. If the user named a product rather than a campaign, resolve it to ids first and list them here."
      },
      "products": {
       "type": "array",
       "items": {
        "type": "string"
       },
       "description": "The SKUs/products the user named, for the human reading the review page. Does not narrow anything by itself."
      }
     }
    }
   },
   "required": [
    "kind"
   ]
  }
 },
 {
  "name": "vibe_seller_list_stores",
  "description": "List all stores in Vibe Seller",
  "inputSchema": {
   "type": "object",
   "properties": {},
   "required": []
  }
 },
 {
  "name": "vibe_seller_list_tasks",
  "description": "List tasks, optionally filtered by store_id or parent_task_id",
  "inputSchema": {
   "type": "object",
   "properties": {
    "store_id": {
     "type": "string",
     "description": "Store ID to filter by (optional)"
    },
    "parent_task_id": {
     "type": "string",
     "description": "Parent task ID — returns only sub-tasks of this parent (optional)"
    }
   },
   "required": []
  }
 },
 {
  "name": "vibe_seller_create_task",
  "description": "Create a new task in Vibe Seller",
  "inputSchema": {
   "type": "object",
   "properties": {
    "title": {
     "type": "string",
     "description": "Task title"
    },
    "store_id": {
     "type": "string",
     "description": "Store ID (optional)"
    },
    "parent_task_id": {
     "type": "string",
     "description": "Parent task ID — set this when creating sub-tasks from an orchestrator task"
    },
    "description": {
     "type": "string",
     "description": "Task description (optional)"
    }
   },
   "required": [
    "title"
   ]
  }
 },
 {
  "name": "vibe_seller_list_cron_jobs",
  "description": "List all scheduled cron jobs",
  "inputSchema": {
   "type": "object",
   "properties": {},
   "required": []
  }
 },
 {
  "name": "vibe_seller_add_cron_job",
  "description": "Add a new cron job that creates tasks on a schedule",
  "inputSchema": {
   "type": "object",
   "properties": {
    "job_id": {
     "type": "string",
     "description": "Unique job ID"
    },
    "task_title": {
     "type": "string",
     "description": "Task title to create"
    },
    "cron_expression": {
     "type": "string",
     "description": "Cron expression: 'minute hour day month day_of_week'"
    },
    "store_id": {
     "type": "string",
     "description": "Store ID for the task (optional)"
    }
   },
   "required": [
    "job_id",
    "task_title",
    "cron_expression"
   ]
  }
 },
 {
  "name": "vibe_seller_email_info",
  "description": "Get email DB paths and schema for a store. Returns per-account: email address, SQLite DB path, attachments dir, sample sqlite3 queries. Emails are synced automatically every 5 minutes. Use sqlite3 CLI to query the DBs directly.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "store_id": {
     "type": "string",
     "description": "Store ID to get email info for"
    }
   },
   "required": [
    "store_id"
   ]
  }
 },
 {
  "name": "vibe_seller_get_new_emails",
  "description": "Scheduled email tasks: fetch ONLY the emails that arrived since the last run. The server reads the email_watermark cursor for your schedule, filters the email DB by it, and returns {count, first_run, watermark_used, next_watermark, accounts:[{email, new_emails:[{message_id, subject, sender, date, epoch, body_text}]}]}. **This is the one call to make for a \"new since last run\" sweep — do NOT query the email DB with raw sqlite3 for it.** An unfiltered SELECT drags already-processed emails into your context and leaks them into this run. After reporting the returned bodies, persist the cursor verbatim: vibe_seller_set_schedule_state('email_watermark', next_watermark). On the first run (no cursor) it returns the last 24h. Scope (store + cursor) is resolved server-side from your task.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "lookback_hours": {
     "type": "integer",
     "description": "First-run window when no cursor exists yet (default 24). Ignored once a cursor is set."
    }
   },
   "required": []
  }
 },
 {
  "name": "vibe_seller_send_email",
  "description": "Send an email via a configured email account. Looks up account by email address. Returns {ok: true, message_id: ...} on success.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "account_email": {
     "type": "string",
     "description": "Email address of the sending account"
    },
    "to": {
     "type": "string",
     "description": "Recipient email address"
    },
    "subject": {
     "type": "string",
     "description": "Email subject"
    },
    "body": {
     "type": "string",
     "description": "Email body (plain text)"
    },
    "body_html": {
     "type": "string",
     "description": "Email body (HTML, optional)"
    }
   },
   "required": [
    "account_email",
    "to",
    "subject",
    "body"
   ]
  }
 },
 {
  "name": "vibe_seller_sync_email_now",
  "description": "Trigger immediate IMAP sync for one email account. Blocks until sync completes. Returns {ok, account_email, new_emails, last_polled_at}. Has a 30s cooldown per account. Then query the email DB via sqlite3 as usual.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "account_email": {
     "type": "string",
     "description": "Email address of the account to sync"
    }
   },
   "required": [
    "account_email"
   ]
  }
 },
 {
  "name": "vibe_seller_write_workspace_file",
  "description": "Write a file to the shared workspace using a relative path (e.g. \"stores/my-store/CATALOG.md\" or \"knowledge/CATALOG.md\"). This is the ONLY reliable way to write to stores/ and knowledge/ directories — the built-in Write tool cannot write through workspace symlinks. Creates parent directories automatically.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "path": {
     "type": "string",
     "description": "Relative path from workspace root (e.g. \"stores/my-store/notes.md\")"
    },
    "content": {
     "type": "string",
     "description": "File content to write"
    }
   },
   "required": [
    "path",
    "content"
   ]
  }
 },
 {
  "name": "vibe_seller_set_task_error",
  "description": "Record an unrecoverable error for the current task (e.g. browser cannot start, required service down). The error message is shown to the user in a red banner. Does NOT transition task status — after you call this, end your session; the infrastructure detects the error on cleanup and transitions the task to FAILED. This preserves post-task knowledge commit and metadata sync even on failure.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "error": {
     "type": "string",
     "description": "Error message explaining the failure"
    }
   },
   "required": [
    "error"
   ]
  }
 },
 {
  "name": "vibe_seller_get_schedule_state",
  "description": "Scheduled tasks only. Read a value that a previous run of the same schedule persisted under `key` — use it to resume from where the last run left off (e.g. last processed email timestamp). Returns an object with `value` (string or null) plus metadata (`key`, `updated_at`, `updated_by_task_id`). On null, the response ALSO includes `other_known_keys` — a list of keys that ARE populated on this schedule. **If your target cursor appears in `other_known_keys` under a different name, you hallucinated the key — retry GET with the listed name instead of treating this as a first-run.** An empty `other_known_keys` list means no prior run has written any cursor yet (truly first run). Scope is resolved server-side from the current task — you never pass a schedule_id, and for fanout schedules the cursor is automatically scoped to YOUR store, so sibling tasks for other stores have their own cursors and won't clobber yours.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "key": {
     "type": "string",
     "description": "Namespaced key, e.g. \"email_watermark\" or \"last_order_id\". Stable across runs."
    }
   },
   "required": [
    "key"
   ]
  }
 },
 {
  "name": "vibe_seller_set_schedule_state",
  "description": "Scheduled tasks only. Persist a value under `key` for the next run of the same schedule to read. Upsert — overwrites any previous value. Use when you consumed a cursor-like resource (emails, orders, messages) and want the next run to resume cleanly.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "key": {
     "type": "string",
     "description": "Same key you read with get_schedule_state."
    },
    "value": {
     "type": "string",
     "description": "Required non-empty string — the cursor to persist for the next run. Format depends on the key; see the canonical-keys table in the task system prompt (Scheduled task — cross-run state). For example, `email_watermark` must be a unix epoch seconds integer string (not ISO), and for a store with linked email accounts it must be the `next_watermark` from vibe_seller_get_new_emails, written verbatim — the server rejects a hand-derived value or one below the floor that tool established. NEVER pass null or an empty string — if you have nothing to persist, do not call this tool.",
     "minLength": 1
    }
   },
   "required": [
    "key",
    "value"
   ]
  }
 },
 {
  "name": "vibe_seller_register_finalize",
  "description": "PLAN PHASE, all-stores fanout schedules only. Register a parent FINALIZE step. A fanout schedule runs this plan once per store in parallel; normally each store finishes on its own and nothing happens after. Call this tool if — and only if — the task needs a SINGLE cross-store step AFTER every store finishes: e.g. combine all stores into ONE pull request / report / notification, or retry the stores that failed. Pass a natural-language `description` of what that final step should do; at run time ONE extra task runs it, handed a batch_results.json listing every store's status + result + output location. If the task is fully independent per store (no combine, no cross-store summary), do NOT call this. You never pass a schedule_id — it is resolved from the current planning task.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "description": {
     "type": "string",
     "description": "Natural-language instruction for the finalize step, e.g. \"After all stores finish, bundle every store and open ONE PR + send ONE WeCom — never one per store.\" Required, non-empty.",
     "minLength": 1
    }
   },
   "required": [
    "description"
   ]
  }
 },
 {
  "name": "vibe_seller_list_wecom_bots",
  "description": "List configured WeChat Work (企业微信) group bots. Returns an array of {id, name} — use the id with vibe_seller_send_wecom_message. Webhook URLs are never returned (they embed secrets).",
  "inputSchema": {
   "type": "object",
   "properties": {},
   "required": []
  }
 },
 {
  "name": "vibe_seller_send_wecom_message",
  "description": "Post a message to a WeChat Work group via its configured bot webhook. Use msgtype=\"markdown\" for reports with headings/tables (WeCom markdown is a reduced subset: headings, **bold**, lists, links, inline code, blockquotes — no tables or images). Hard limit: 4096 bytes per message; split longer content across multiple calls.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "bot_id": {
     "type": "string",
     "description": "Bot ID from vibe_seller_list_wecom_bots."
    },
    "content": {
     "type": "string",
     "description": "Message body (non-empty).",
     "minLength": 1
    },
    "msgtype": {
     "type": "string",
     "enum": [
      "text",
      "markdown"
     ],
     "description": "'text' (default) or 'markdown'."
    }
   },
   "required": [
    "bot_id",
    "content"
   ]
  }
 },
 {
  "name": "vibe_seller_send_wecom_file",
  "description": "Send a local file (PDF, image, xlsx, …) to a WeChat Work group via its configured bot — e.g. a payment receipt (comprovante) or a report. Pass the bot_id and an absolute path on this host (task captures under /tmp, browser downloads under ~/.vibe-seller/downloads). Limit: 20 MB. The webhook secret stays on the server.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "bot_id": {
     "type": "string",
     "description": "Bot ID from vibe_seller_list_wecom_bots."
    },
    "path": {
     "type": "string",
     "description": "Absolute path to the file on this host.",
     "minLength": 1
    }
   },
   "required": [
    "bot_id",
    "path"
   ]
  }
 },
 {
  "name": "vibe_seller_set_task_result",
  "description": "Record the **final task result** shown to the user in the GUI. The result field renders as markdown.\n\nTwo ways to call this:\n\n1. **Direct content** — pass the result text directly. Use when the deliverable is short (roughly < 10 KB): a one-line confirmation, a short summary, a JSON payload, a metric row.\n\n2. **File pointer** — pass a relative path to a file you already wrote in your CWD (e.g. `\"./NOON_AE_ADS_AUDIT_2026-04-30.md\"`). The backend detects when the value is a file path inside the task workspace, reads the file, and uses its contents as the GUI-visible result. **Use this for long-form deliverables (full reports, audits, plans).** Compose those with the built-in `Write` tool first — `Write` streams content as you compose it, which is much faster than packing a 25KB payload into one MCP tool call (some providers stall on large monolithic tool inputs).\n\nDoes NOT mark the task completed — completion is automatic when your agent session ends and the post-task cleanup runs. If you never call this, your last assistant message is saved as the result.\n\nDeclares you have a deliverable. If it is PARTIAL, still call this — pass the partial output and list what is missing in `incomplete`. That is the right way to end an unfinished-but-useful run.\n\nReserve `vibe_seller_set_task_error` for having **no usable deliverable at all** (browser never started, site unreachable). It means unrecoverable failure — do not use it to explain caveats about work you did produce.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "result": {
     "type": "string",
     "description": "Result summary to record"
    },
    "incomplete": {
     "type": "array",
     "items": {
      "type": "string"
     },
     "description": "Optional. One short line per thing you could NOT finish. Use this — not vibe_seller_set_task_error — when you have a usable deliverable but it is partial. The items are shown to the user as caveats on the result. This does NOT skip any review: your result is checked exactly as it would be otherwise."
    }
   },
   "required": [
    "result"
   ]
  }
 },
 {
  "name": "vibe_seller_list_skills",
  "description": "List the skills available in this workspace so you can decide whether to EXTEND an existing one or CREATE a new one. Call this FIRST when the user asks to \"save this workflow as a skill\" / \"保存为技能\". Returns an array of {slug, name, description, source, updatable}. `source` is 'builtin' (maintainer-shipped, READ-ONLY — never edit; reference it instead), 'imported' (installed from a URL), or 'custom' (user-authored here). `updatable` is true only for skills you may overwrite with vibe_seller_save_skill (custom + imported). Match on the `description` — that is the skill selection signal — not just the slug.",
  "inputSchema": {
   "type": "object",
   "properties": {},
   "required": []
  }
 },
 {
  "name": "vibe_seller_save_skill",
  "description": "Create or extend a USER-space skill in the shared workspace so it persists after this task and auto-loads for future tasks. Writing via the built-in Write tool does NOT persist — the task's .claude/ copy is discarded — so this MCP tool is the ONLY way to save a skill.\n\nPass `slug` (lowercase letters/digits/hyphens), the full `skill_md` (SKILL.md content: YAML frontmatter with `name` and a trigger-packed third-person `description`, then a concise heuristic body), and optional `files` (a map of relative-path → content for bundled references/scripts). If `slug` already names a custom/imported skill this OVERWRITES it (extend by passing the merged full content — read the current SKILL.md first). HARD RULE: built-in (maintainer-shipped) slugs are rejected — they are read-only. If the closest match is a built-in, choose a NEW slug and create a user-space skill that may reference the built-in.",
  "inputSchema": {
   "type": "object",
   "properties": {
    "slug": {
     "type": "string",
     "description": "Skill directory slug — lowercase letters, digits, hyphens (e.g. \"revenue-report\")."
    },
    "skill_md": {
     "type": "string",
     "description": "Full SKILL.md content (frontmatter + body).",
     "minLength": 1
    },
    "files": {
     "type": "object",
     "description": "Optional bundled files: {relative_path: content}. Paths are relative to the skill directory; no absolute paths or \"..\".",
     "additionalProperties": {
      "type": "string"
     }
    }
   },
   "required": [
    "slug",
    "skill_md"
   ]
  }
 },
 {
  "name": "vibe_seller_generate_image",
  "description": "Generate an image from a text prompt plus optional reference images, using the configured vision model. General-purpose: product photos, marketplace listing images, infographics, banners, illustrations, or an image the user just wants for fun — any platform, any purpose. For platform-specific image work (e.g. Amazon listing images), load the matching skill first if one exists; it carries that platform's requirements and workflows. Contract: (1) Write the `prompt` in the USER's language. (2) When the image must depict a REAL product or person, pass photos of it as `reference_images` and instruct the model to replicate them faithfully — never describe its appearance (material/texture/shape) in words, and state each reference image's role by position in the prompt (\"image 1 is the style reference; images 2-3 are the product\"). (3) This call PAUSES for the user to review and edit the prompt/model before anything is generated — that is expected; wait for the result. The model on the card is the USER's choice — if a call fails, RETRY THE SAME MODEL. A 504 \"still running\" means the job is alive on the provider and a retry with that same model resumes it at no extra cost; switching models abandons a paid image, produces a different one, and overrides what the user picked. (4) It fails immediately if no vision key is configured — tell the user to set it in Settings → AI → Vision. On success it returns the saved workspace `path`; view the file to self-audit against the references and the requested text, and regenerate with a corrected prompt if anything differs. If you CANNOT actually see the image (the Read comes back as something you cannot look at), say so and let the USER judge — it is displayed inline in the task. Never substitute a pixel-measurement script for looking, and never act on what such a script measured. (5) EVERY image this tool is asked for — including \"just remove the background\", \"only crop it\", \"make it pure white\" — is produced by the MODEL, through this tool. NEVER build or repair an image deliverable locally: no rembg, no Pillow/OpenCV compositing, no ImageMagick, no writing into `generated_images/` (that directory is this tool's, and each file's recorded prompt+model is what the user's inline card claims). Those paths are blocked by a PreToolUse guard. If a result is wrong, fix it the way (6) describes. (6) REVISING an image you already generated — for ANY change, whether the USER asked for it (lighter/darker, bigger/smaller, recolour, remove or add an element, change composition) or YOUR OWN audit found it (background not pure white, product touching the edges or filling too much of the frame, misspelt on-image text): call this tool again and ALWAYS include the PREVIOUS generated image (its workspace `path`, e.g. generated_images/…) as a reference_image, with a prompt describing ONLY the change — so the model EDITS that result and preserves what the user already liked, instead of regenerating from scratch and drifting. If the user also supplies NEW photo(s) for the change (e.g. \"this image is good, add the dog from this photo into the middle\"), pass BOTH the previous generated image AND the new photo(s) as reference_images, and state each image's role by position in the prompt (e.g. \"image 1 is the current design to keep; image 2 is the dog — place it in the center\").",
  "inputSchema": {
   "type": "object",
   "properties": {
    "prompt": {
     "type": "string",
     "description": "Image prompt in the user's language. Describe composition, background, style, and any on-image text (spelled exactly). If reference images are passed, assign each a role by position and do NOT describe the referenced subject's appearance in words.",
     "minLength": 1
    },
    "reference_images": {
     "type": "array",
     "items": {
      "type": "string"
     },
     "description": "Reference image URLs and/or workspace-relative file paths, in the order the prompt refers to them. Up to 14. The referenced subject's true appearance is taken from these. When the user provides MULTIPLE photos of the SAME product (different angles/views/details), pass them ALL as references for ONE generation — they are views of a single subject, not separate products. Do NOT generate one image per photo. Only make separate calls if the user clearly asked for several DISTINCT products/images; if unsure which they meant, ask before generating."
    },
    "model": {
     "type": "string",
     "enum": [
      "<<MODEL_IDS>>"
     ],
     "description": "Image model + tier to use. The user can override this on the confirm card, so pick a sensible default and let them adjust. The default is the safest for on-image TEXT (infographics, banners) and high quality; cheaper lanes and higher resolutions are available. <<MODEL_GUIDE>>."
    },
    "output_name": {
     "type": "string",
     "description": "Output file name, e.g. \"banner.png\". Saved under the task workspace and shown inline to the user."
    },
    "kind": {
     "type": "string",
     "description": "Optional short label shown on the confirm card (e.g. \"main\", \"infographic\", \"banner\", \"fun\")."
    }
   },
   "required": [
    "prompt"
   ]
  }
 }
];
// ── 生成段结束 ──

/** 原 mcp_tool_schemas.py:22-29：providers 保序去重 + 固定文案 + 默认模型 id。
 * 入参放宽为 Record（catalogPublic() 的返回形状），provider 取值转 String。 */
export function imageModelGuide(catalog: readonly Record<string, unknown>[], defaultModel: string): string {
  const providers = [...new Set(catalog.map((m) => String(m["provider"])))].join(", ");
  return (
    `Providers: ${providers}. Each model offers resolution/` +
    `quality tiers (1K/2K/4K etc.) as separate ids with their own price. ` +
    `Default ${defaultModel}`
  );
}

/** 补全 generate_image 的动态位（enum + 指导语），其余工具原样返回。 */
export function buildNativeToolSchemas(opts: { imageModelIds: readonly string[]; imageModelGuide: string }): McpToolDef[] {
  return MCP_TOOL_SCHEMAS.map((t) => {
    if (t.name !== "vibe_seller_generate_image") return t;
    const props = { ...(t.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties };
    const model = props["model"] ?? {};
    props["model"] = {
      ...model,
      enum: [...opts.imageModelIds],
      description: String(model.description ?? "").split(MODEL_GUIDE_PLACEHOLDER).join(opts.imageModelGuide),
    };
    return { ...t, inputSchema: { ...(t.inputSchema as object), properties: props } };
  });
}

/** 原 _visible_tools（mcp_server.py:40-47）：无能力 → 隐藏 generate_image。 */
export function filterVisibleTools(schemas: readonly McpToolDef[], visionCapability: boolean): McpToolDef[] {
  if (visionCapability) return [...schemas];
  return schemas.filter((t) => t.name !== "vibe_seller_generate_image");
}

/**
 * 服务令牌（原 claude_backend.py:498-545 实读裁决）：role='ai_bot' 的用户存在 →
 * (bot.id, 'ai_bot')；否则 ('system','admin')。TTL = SERVICE_TOKEN_EXPIRE 7 天
 * （auth.py:29——服务令牌非交互式，须活得比用户会话久）。原实现每任务注册 MCP 时
 * 签发一次；等价时机 = 每 run 工厂组装。
 */
export function mintServiceToken(db: DatabaseSync, jwtSecret: string): string {
  const bot = db.prepare("SELECT id FROM users WHERE role = 'ai_bot'").get() as { id: string } | undefined;
  return bot
    ? createSessionToken(bot.id, "ai_bot", jwtSecret, SERVICE_TOKEN_EXPIRE_SECONDS)
    : createSessionToken("system", "admin", jwtSecret, SERVICE_TOKEN_EXPIRE_SECONDS);
}

// ── sanitize_json（原 app/text_utils.py:74-90）──

const SURROGATE_RE = /[\uD800-\uDFFF]/;

/** 原 sanitize_text：孤立代理对 → U+FFFD；无代理对原串返回。 */
export function sanitizeText(text: string): string {
  if (!SURROGATE_RE.test(text)) return text;
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += c >= 0xd800 && c <= 0xdfff ? "\uFFFD" : ch;
  }
  return out;
}

/**
 * 原 sanitize_json：出站 body 递归清洗。原注释（text_utils.py:78-83）：httpx 以
 * ensure_ascii=False 序列化后编 UTF-8，孤立代理对会在 MCP 进程内炸掉、服务端
 * SafeStr 字段根本见不到请求——所以清洗必须发生在序列化之前。进程内 JSON.stringify
 * 虽然容忍代理对（转义成合法 JSON），但服务端落库文本必须与 Python 管线逐字节一致，
 * 边界照留。
 */
export function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeJson(v);
    return out;
  }
  return value;
}

// ── dispatch（原 handle_tool_call :111-308 的路由表）──

interface RoutedRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

/** Python arguments[key]：缺失 → KeyError（str() 为带引号键名）；null 照传。 */
function req(args: Record<string, unknown>, key: string): unknown {
  const v = args[key];
  if (v === undefined) throw new Error(`'${key}'`);
  return v;
}

/** Python int()（原 :158 只用于 lookback_hours）：数值截断，字符串须整数字面量。 */
function toInt(v: unknown): number {
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new Error("cannot convert float NaN to integer");
    return Math.trunc(v);
  }
  const s = String(v).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new Error(`invalid literal for int() with base 10: '${String(v)}'`);
  return Number.parseInt(s, 10);
}

/** Python quote(s, safe='')：encodeURIComponent 不编码 ! * ' ( )，逐一补上（大写十六进制）。 */
function pyQuote(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function routeTool(name: string, a: Record<string, unknown>, taskId: string): RoutedRequest | undefined {
  switch (name) {
    case "vibe_seller_list_stores":
      return { method: "GET", path: "/api/stores" };
    case "vibe_seller_list_tasks": {
      // 原 :117-121：get() 真值才进查询串（f-string 原样拼装，不额外编码）
      const params: string[] = [];
      if (a["store_id"]) params.push(`store_id=${a["store_id"]}`);
      if (a["parent_task_id"]) params.push(`parent_task_id=${a["parent_task_id"]}`);
      return { method: "GET", path: params.length ? `/api/tasks?${params.join("&")}` : "/api/tasks" };
    }
    case "vibe_seller_create_task":
      // 未提供的可选键经 JSON 序列化丢弃；Python 发 null——服务端 Optional 字段两者同值
      return { method: "POST", path: "/api/tasks", body: { title: req(a, "title"), store_id: a["store_id"], parent_task_id: a["parent_task_id"], description: a["description"] } };
    case "vibe_seller_list_cron_jobs":
      return { method: "GET", path: "/api/cron/jobs" };
    case "vibe_seller_add_cron_job":
      return {
        method: "POST",
        path: "/api/cron/jobs",
        body: { job_id: req(a, "job_id"), task_title: req(a, "task_title"), cron_expression: req(a, "cron_expression"), store_id: a["store_id"] },
      };
    case "vibe_seller_email_info":
      return { method: "GET", path: `/api/email-accounts/info-by-store/${req(a, "store_id")}` };
    case "vibe_seller_get_new_emails": {
      // 原 :157-158：is not None 判定（null 不带查询串）
      const qs = a["lookback_hours"] !== undefined && a["lookback_hours"] !== null ? `?lookback_hours=${toInt(a["lookback_hours"])}` : "";
      return { method: "GET", path: `/api/tasks/${taskId}/new-emails${qs}` };
    }
    case "vibe_seller_sync_email_now":
      return { method: "POST", path: "/api/email-accounts/sync-now", body: { account_email: req(a, "account_email") } };
    case "vibe_seller_write_workspace_file":
      // 原 :196：path 原样插值（未编码）——保真保留
      return { method: "PUT", path: `/api/workspace/file?path=${req(a, "path")}`, body: { content: req(a, "content") } };
    case "vibe_seller_set_task_error":
      // 只记录不转状态（原 :199-208 注释：状态归 auto_run_task 清理）
      return { method: "POST", path: `/api/tasks/${taskId}/error`, body: { error: req(a, "error") } };
    case "vibe_seller_declare_ad_task":
      // scope falsy → {}（原 :216 or {}）
      return { method: "POST", path: `/api/tasks/${taskId}/ad-declaration`, body: { kind: a["kind"], scope: a["scope"] || {} } };
    case "vibe_seller_get_schedule_state":
      return { method: "GET", path: `/api/tasks/${taskId}/schedule-state/${pyQuote(String(req(a, "key")))}` };
    case "vibe_seller_set_schedule_state":
      return { method: "PUT", path: `/api/tasks/${taskId}/schedule-state/${pyQuote(String(req(a, "key")))}`, body: { value: a["value"] } };
    case "vibe_seller_register_finalize":
      return { method: "POST", path: `/api/tasks/${taskId}/register-finalize`, body: { description: req(a, "description") } };
    case "vibe_seller_send_wecom_message":
      return {
        method: "POST",
        path: `/api/wecom-bots/${req(a, "bot_id")}/send`,
        body: { content: req(a, "content"), msgtype: a["msgtype"] ?? "text" },
      };
    case "vibe_seller_send_wecom_file":
      return { method: "POST", path: `/api/wecom-bots/${req(a, "bot_id")}/send-file`, body: { path: req(a, "path") } };
    case "vibe_seller_set_task_result":
      // 只落结果不转状态（原 :261-272 注释）；incomplete falsy → []
      return { method: "POST", path: `/api/tasks/${taskId}/result`, body: { result: req(a, "result"), incomplete: a["incomplete"] || [] } };
    case "vibe_seller_generate_image":
      // 无超时：服务端阻塞等人工确认（原 :273-288 timeout=None；进程内自调无超时层，语义天然成立）
      return {
        method: "POST",
        path: `/api/tasks/${taskId}/image/generate`,
        body: { prompt: req(a, "prompt"), model: a["model"], reference_images: a["reference_images"] ?? [], output_name: a["output_name"], kind: a["kind"] },
      };
    case "vibe_seller_list_skills":
      return { method: "GET", path: "/api/workspace/skills" };
    case "vibe_seller_save_skill":
      // files 真值才带（原 :296-297）
      return {
        method: "PUT",
        path: `/api/workspace/skills/${pyQuote(String(req(a, "slug")))}`,
        body: a["files"] ? { skill_md: req(a, "skill_md"), files: a["files"] } : { skill_md: req(a, "skill_md") },
      };
    default:
      return undefined;
  }
}

export interface NativeToolPortDeps {
  /** 进程内自调目标（等价原 call_api 的 api_base = loopback FastAPI）。 */
  app: Hono;
  taskId: string;
  /** 服务令牌；原实现以 cookie auth_token 附带（mcp_server.py:82-83）。 */
  authToken: string;
  /** 测试注入请求层（记录器/假上游）；缺省 app.request。 */
  request?: (path: string, init: RequestInit) => Promise<Response>;
}

/**
 * 结果判别（packages/bridge/src/mcp.ts:138-151 同一判别式，对齐原 MCP stdio 客户端
 * 的消费语义）：单键 {"error": …} → error 状态；其余 → success（数组/对象原样，
 * 原语包 {text}）。未知工具走同一出口（原 :304 返回单键 error 文本）。
 */
function toToolCallResult(parsed: unknown): ToolCallResult {
  const looksLikeError =
    typeof parsed === "object" && parsed !== null && "error" in parsed && Object.keys(parsed as object).length === 1;
  if (looksLikeError) {
    const errValue = (parsed as { error: unknown }).error;
    const message = typeof errValue === "string" ? errValue : JSON.stringify(parsed);
    return { status: "error", error: { code: "tool_error", message } };
  }
  return {
    status: "success",
    result: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { text: JSON.stringify(parsed) },
  };
}

/** 原生 ToolPort：execute 的 signal 语义与原 MCP 客户端一致（无中止传播，参数位保留）。 */
export function createNativeToolPort(deps: NativeToolPortDeps): ToolPort {
  const doRequest = deps.request ?? ((path: string, init: RequestInit) => deps.app.request(path, init));

  const callApi = async (routed: RoutedRequest): Promise<unknown> => {
    // 原 :79：先清洗再序列化（sanitize 在 httpx 编码前）
    const body = routed.body === undefined ? undefined : JSON.stringify(sanitizeJson(routed.body));
    const headers: Record<string, string> = { cookie: `auth_token=${deps.authToken}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    // 原 :108：resp.json() 直返，不判状态码（无 raise_for_status）
    const res = await doRequest(routed.path, { method: routed.method, headers, ...(body !== undefined ? { body } : {}) });
    return res.json();
  };

  /** 原 handle_tool_call 的 send_email 分支（:163-186）：MCP 层先按邮箱查账户 ID。 */
  const sendEmailFlow = async (a: Record<string, unknown>): Promise<unknown> => {
    const accountEmail = req(a, "account_email");
    const all = await callApi({ method: "GET", path: "/api/email-accounts" });
    let accountId: unknown = null;
    for (const acct of Array.isArray(all) ? all : []) {
      if ((acct as Record<string, unknown>)["email"] === accountEmail) {
        accountId = (acct as Record<string, unknown>)["id"];
        break;
      }
    }
    if (!accountId) return { error: `No account found for ${accountEmail}` };
    const sendBody: Record<string, unknown> = { to: req(a, "to"), subject: req(a, "subject"), body: req(a, "body") };
    if (a["body_html"]) sendBody["body_html"] = a["body_html"];
    return callApi({ method: "POST", path: `/api/email-accounts/${String(accountId)}/send`, body: sendBody });
  };

  const handle = async (name: string, a: Record<string, unknown>): Promise<unknown> => {
    if (name === "vibe_seller_send_email") return sendEmailFlow(a);
    if (name === "vibe_seller_list_wecom_bots") {
      // 原 :237-244：API 返回打码 URL，剥离为 {id,name}——webhook secret 不进代理结果
      const bots = await callApi({ method: "GET", path: "/api/wecom-bots" });
      return (Array.isArray(bots) ? bots : []).map((b) => ({
        id: (b as Record<string, unknown>)["id"],
        name: (b as Record<string, unknown>)["name"],
      }));
    }
    const routed = routeTool(name, a, deps.taskId);
    if (!routed) return { error: `Unknown tool: ${name}` };
    return callApi(routed);
  };

  return {
    execute: async (intent: ToolIntent): Promise<ToolCallResult> => {
      const args = (intent.arguments ?? {}) as Record<string, unknown>;
      try {
        return toToolCallResult(await handle(intent.name, args));
      } catch (err: unknown) {
        // 原 :307-308 except 分支：单键 {"error": str(e)} 包在成功结果里
        return { status: "error", error: { code: "tool_error", message: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}
