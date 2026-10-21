# 路线 4 PRD：遗留台账攒批清理（第一批）

> **版本**：v1.0（2026-10-10）
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
