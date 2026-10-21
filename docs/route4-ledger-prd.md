# 路线 4 PRD：遗留台账攒批清理（第一批）

> **版本**：v1.2（2026-10-21；v1.0 为 2026-10-10，v1.1 / v1.2 差异见 §五 修订记录，冲突时以 §五 为准，新版本优先）
> **规格来源**：`docs/roadmap.md` 路线 4 + `docs/审查记录.md` 各批台账（4.7 / Phase 5 / 路线 1 观察项 / 路线 2 十一项 / 路线 3 七项）。
> **启动依据**：用户指令"攒批清台账（路线 4）"。原 roadmap 建议"真实使用一个月后清"，用户选择现在清——以本 PRD 的范围裁决消化该提前量：**只做确定性可验、收益明确的小项；需要真实使用反馈或参考仓库对证环境的留台账**。
> **需求采访说明**：每项的出处与现状都在台账有据；对照参考实现核实的项（S2）以 `_reference/vibe-seller-src` 为准。实现中发现某项与原实现行为冲突或不可行，按变更授权停报该项（不影响同批其他项）。

---

## 一、范围裁决

### 做（15 项，全部确定性可验）

**browser/starter 行为小修（源出路线 2 台账）**

| 编号 | 项 | 现状与修法 |
|---|---|---|
| S3 | tab LRU 驱逐按时间戳排序 | browse.ts `enforceTabCap` 现按 Map 插入序，未知 tab（ts=0）追加尾部反而最后被驱逐，违反"关最久未用"；修 = 驱逐候选取 min(lastUsed)，未知 tab 视作最旧 |
| S5 | smoke 清理健壮化收尾 | chrome_pid 采集在断言 rethrow 之前（失败路径也能杀进程）；更新已陈旧的 peek 轮询 workaround 注释（Major2 修复后已不需要） |
| S6 | 重复实现收敛 | click/type 的三连鼠标事件序列抽 `clickAt()` 单处实现；`isBrowseToolName` 双实现（browse.ts 类型守卫 / native-tools.ts 布尔版）收敛为单一导出 |
| S7 | load_state=timeout 不落 current_url | navigate 超时时 evaluate 可能命中旧页，把旧 URL 记成新 URL；修 = 仅 `load_state:"loaded"` 落库 |
| S8 | 快路径补会话行 | 就绪超时（>10s）后 Chrome 迟到就绪的场景：peek 命中但 browser_sessions 行停留陈旧态；修 = peek 命中且行非 running 时补一次 upsert（与 markSessionRow 同形状） |
| S9 | 闸门拒绝后 GUI 结果为空 | 路线 1 验收观察项：拒绝路径模型有明确 respond 文本但 `transcript_tail`/`submitted_result` 为空。**先查根因**（transcript_tail 写入路径 vs respond 事件的落点），若为缺陷修复之；若属原版同面语义则记录闭项 |

**server 契约与一致性（源出 4.7/Phase 5/路线 1 台账）**

| 编号 | 项 | 现状与修法 |
|---|---|---|
| S1 | storeSlug 5 份拷贝统一 | routes_tasks/starter/bookmarks/reapers/assistant 各有本地 slug 实现，`workspace/storeData.ts` 已导出正主 `storeSlug()`；统一为导入正主，其余删除；行为差异点（id8 后缀回退）逐处核对，附旧 `-id8` 目录迁移说明注释 |
| S2 | users PUT username 校验对账 | TS PUT 无校验；**对照参考实现 `app/users.py` 的 UserUpdate 核实**——原版有则按原版语义补齐（形状对齐 POST 侧先例），原版也没有则记录"行为一致"闭项 |
| G1 | /api/version 缺省值统一 | version 端点 `0.0.0+dev` 与遥测 `app_version=0.1.0` 并存；统一到 package.json 单一来源（一处常量/构建注入，行为择一对证原实现后固定） |

**脚本与门禁小修（源出路线 3 台账 + 4.7 台账）**

| 编号 | 项 | 现状与修法 |
|---|---|---|
| S10 | 扫描器报错文案中文化 | staged 总量 >64MB（ENOBUFS）与 `resp.json()` 解析失败目前是英文技术码；映射为中文可操作提示（含"分批提交"指引），exit 2 语义不变 |
| S11 | --raw 加 --no-abbrev | dstSha 受 core.abbrev 截短，靠歧义自动加长 + fail-closed 兜底；加 `--no-abbrev` 一次到位（全量 sha，消除歧义面） |
| S12 | commit-msg 剥 BOM | UTF-8 BOM 开头的 msgfile 会被误判"未知类型"；剥一个前导 \uFEFF（git 不写 BOM，某些 Windows 编辑器会） |
| S13 | 安装器清单一致性测试 | 新增断言：`scripts/githooks/` 目录内实际 hook 文件集合 ⊆ REQUIRED_HOOKS（防"新增 hook 忘登记"） |
| S14 | unstaged 不扫回归钉 | §六.5"不扫 unstaged/未跟踪"目前只靠 git show :path 结构性保证；补一条真仓回归测试（工作区脏改 + 未跟踪密钥文件在场，staged 干净 → 放行） |
| G2 | start.bat（release）TOCTOU | pid 检查与写入之间的窗口；修 = pid 文件写临时名后 `move /y` 原子替换（单机低危，顺手收） |
| G3 | vendor-frontend 路径文档化 | --source/env 覆盖已有；AGENTS.md 补一句"换机/CI 需显式传参"（文档化闭项，不改码） |

### 不做（留台账，理由随交付报告）

性能类（read/eval 全量取回切片、withBudget 不取消底层、wait 120s 刀刃）；假 CDP 夹具三处提取共享（等下次测试基建大改顺手做）；pyJsonDumps ensure_ascii（需参考 venv 对证环境，单独立项）；generate_image 挂起期 stop 悬挂（原版同面语义）；route 2 台账 4（夹具提取同前）；并发首装、unmerged 态、POSIX 冒号缝隙（理论面）。

## 二、验收条件

1. 每项至少一条确定性测试（或对证记录）钉住新行为；S2 若判定"原版同面"则产出对证摘录并闭项。
2. 既有全量测试 / 回放 / e2e 零回归；每任务 `npm run verify -- --scope <范围> --base <回滚点>` 全绿。
3. S1 统一后全仓 grep 无第二份 slug 实现残留；S6 后 `isBrowseToolName` 单一来源；S13/S14 新测试真实可红（篡改变红验证一次）。
4. 双重审查（规格 + 质量）通过并落档；roadmap 路线 4 状态回写；审查记录新增本批台账处置表。

## 三、非目标

1. 不做台账中"不做"清单所列项（理由如上，均在台账留痕）。
2. 不引入新依赖、不动 frontend/、不改 DB schema、不动 verify 四门禁定义。
3. 不借机重构任何项范围外的代码（最小 diff 纪律）。

## 四、任务拆分与回滚点

| 任务 | 内容 | 回滚点 |
|---|---|---|
| T1 | S9 根因调查 + S3/S5/S6/S7/S8（browse/starter/smoke 侧） | 本 PRD commit |
| T2 | S1/S2/G1/G2/G3（server 契约与脚本侧） | T1 commit |
| T3 | S10/S11/S12/S13/S14（githooks 侧） | T2 commit |
| T4 | 双重审查 + 整改 + 文档回写 + 落档 | T3 commit |

## 五、修订记录

### v1.2（2026-10-21）

T3 动工前对照 HEAD `407aaa8` 逐项核对（临时仓实测，仓库未动），以下差异经用户批准生效。S10–S12 改动 git hooks 校验逻辑、S13 给安装器加导出，属 AGENTS.md 敏感区⑤ / 宪法第 6 条，用户已在本会话单独批准 T3 修改 `scan-secrets.mjs`、`commit-msg.mjs`、`hooks-install.mjs`（仅加 `export`）。T3 回滚点 / verify base = `407aaa8`（T2 之后的交接文档提交）。

| 项 | v1.1 | v1.2 | 依据 |
|---|---|---|---|
| S10 | ENOBUFS 与 `resp.json()` 解析失败都映射为中文提示 | 拆成两半。(a) ENOBUFS（路线 3 台账 #1）：scan-secrets 一次读取全部 staged 文本时超过 64MB 上限，现提示为英文技术码（68MB 实测 `spawnSync git ENOBUFS`，exit 2）；改为中文可操作提示（含 64MB 上限与"分批提交"指引），exit 2 不变。(b) `resp.json()` 不在 scan-secrets 里，出自路线 2 台账 #11（`browser/cdp.ts` overPort 对 HTTP 200 但非 JSON 的响应未包前缀文案），v1.0 误并入 S10；按 PRD 原意一并修：补上与 overPort 其余失败路径同形的 `browser session not ready on port <port>` 前缀，不中文化 | T3 核对 + 用户批准 |
| S11 | 加 `--no-abbrev` | 照做。实测默认输出 7 位短 sha，但 git 会自动加长到唯一，cat-file 遇到歧义也会 fail-closed，外部行为与全量 sha 不可区分，属加固。测试用 `GIT_TRACE` 断言 `diff --raw` 那次调用带 `--no-abbrev`（参数级断言） | T3 核对 + 用户批准 |
| S12 | 剥一个前导 `\uFEFF` | 只在校验时剥（`main` 读文件后），不回写提交信息文件。实测带 BOM 的消息被误拒（JS 的 `\s` 含 U+FEFF，报"行首无类型词元"）；git 会把 BOM 原样写进提交 subject，放行后这类提交的 subject 开头仍有一个不可见的 BOM，接受 | T3 核对 + 用户批准 |
| S13 | 断言 hook 文件集合 ⊆ REQUIRED_HOOKS | "hook 文件"定义为 `scripts/githooks/` 下没有扩展名的常规文件；`REQUIRED_HOOKS` 原未导出，`hooks-install.mjs` 只加 `export`，逻辑不变 | T3 核对 + 用户批准 |

S14 核对确认行为已成立（工作区脏改 + 未跟踪密钥、staged 干净时放行；对照组 stage 脏改后被拦），按 v1.0 补回归钉，无差异。

### v1.1（2026-10-21）

v1.0 的条目是对着 10-10 的代码裁决的。10-12 到 10-14 的共享浏览器组等交付改动了相关代码，T1、T2 动工前逐项对照 HEAD 核对后，以下差异经用户批准生效：

| 项 | v1.0 | v1.1 | 依据 |
|---|---|---|---|
| S3 | 驱逐候选取 min(lastUsed) | 共享组与非共享两个分支统一按最近使用时刻升序驱逐。核对时发现现状比 v1.0 描述更严重：非共享会话里，页面弹窗攒多后刚开的新 tab 会被立即关掉 | T1 核对 + 用户批准 |
| S5 | 更新陈旧注释 | 删除已失效的冷启动兜底：starter 的就绪等待已保证首调成功 | 用户批准 |
| S8 | 补一次 upsert | 已被 `8be2d51` 覆盖，补钉测试后闭项。快路径补行拿不到 chrome_pid，这个缺口留台账（生产代码无读取方） | T1 核对 + 用户批准 |
| S9 | 先查根因 | 查实不是缺陷：10-10 现场库里 result 与 transcript_tail 都有拒绝文本；GET 任务接口与原版 TaskResponse 一致，不返回 transcript_tail，当时据此误判。补回归钉后闭项 | 现场只读对证 |
| S1 | 5 份拷贝（含 bookmarks） | bookmarks 已由 `8be2d51` 改走 storeSessionIdentity；新增一份 `routes_workspace.ts` 内联拷贝。storeSessionIdentity 是建在 storeSlug 之上的会话身份层，非共享店的 slug 改用正主 storeSlug。实现中又发现 `agent/prompt.ts` 的 storeContext 里有第 6 份，仍是 4.7.2 之前的带 `-<id8>` 后缀旧公式，导致之后建的店 STORE.md 一律读不到、店铺档案上下文被静默丢掉；一并改用正主 | T2 核对 + 用户批准 |
| S2 | 只补 username 校验 | 整条 `PUT /api/users/:id` 对齐原版 `update_user`：username 校验（422，与 POST 同形状，先于 404）、ai_bot 禁改、排除自己的用户名/邮箱唯一性、role 白名单、email 可显式置空、唯一约束冲突映射 400。邮箱格式校验（EmailStr）POST 与 PUT 都缺，另留台账 | 原版对证 + 用户批准 |
| G1 | 统一到 package.json | 抽叶子模块 `version.ts`（对齐原版 `app/version.py`），健康、版本、系统信息三个接口与遥测同源；`VIBE_VERSION` 覆盖保留 | 原版对证 |
| G2 | 临时名 + `move /y` 原子替换 | 闭项不改。该修法只能防读到半截文件，关不掉检查与写入之间的竞态；真正关窗需要锁目录，又会引入锁残留的新故障面；单机单实例无实害 | 用户批准 |
| G3 | 只补文档 | 修 bug：来源目录检查挪进复制分支，`--check` 不再依赖参考仓库路径；补脚本测试；AGENTS.md 补 `--source` 说明。v1.0 所说的"env 覆盖"并不存在 | T2 核对 + 用户批准 |
