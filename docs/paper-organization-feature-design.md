# Paper Organization Feature Design

- Status: Accepted feature design
- Date: 2026-07-31
- Scope: Research Direction、Paper Alias、Paper Catalog、人工整理与 Agent 建议
- Product baseline: [`PRD.md`](PRD.md)
- Data baseline: [`data-model.md`](data-model.md)
- Frontend baseline: [`frontend-information-architecture.md`](frontend-information-architecture.md)
- Vocabulary: [`../CONTEXT.md`](../CONTEXT.md)
- External review: [`archive/reviews/fable-review-2026-07-31-paper-organization.md`](archive/reviews/fable-review-2026-07-31-paper-organization.md)
- Implementation: Slices 1–4D complete as of 2026-08-01; historical per-slice plans
  are archived under [`plans/`](plans/), with review summaries under
  [`archive/reviews/`](archive/reviews/).

## 1. Purpose

当 Paper 数量增长后，单一时间顺序列表不足以支持回顾、检索和继续研究。
本功能以 Research Direction 组织 Paper，并允许使用模型名、方法名、缩写或个人称呼
作为 Paper Alias。它必须保持正式论文身份、用户策展、Agent 建议和检索投影之间的边界：

- canonical Paper title 和 External Identity 不因别名改变；
- Research Direction 复用 Topic，不建立平行 Category 体系；
- 已确认组织信息进入 authoritative Paper/Topic Markdown；
- Proposal、ReviewDecision、Job、写入恢复和索引状态留在 SQLite；
- Paper Catalog 与 `global-curated` 知识语料保持分离。

## 2. Goals and non-goals

### 2.1 Goals

1. Paper 可拥有多个 Alias，并有至多一个 Preferred Paper Alias。
2. Paper 可拥有至多一个 Primary Research Direction 和至多三个 Secondary Research Directions。
3. Paper Library 按 Primary 唯一组织，同时能通过 Secondary 检索和筛选。
4. 用户可以低摩擦地手动编辑 Alias 和 Direction。
5. Agent 可以为已有和新 Paper 提出可解释建议，但首发不自动接受。
6. 方向体系可以被创建、改名、调整 Scope 和合并，并保留稳定身份与可恢复迁移。
7. Paper Catalog 可从 authoritative Markdown 确定性重建。
8. Alias 能用于日常检索，同时不被误当成论文标题、External Identity 或模型实体。

### 2.2 Non-goals

- 首发不建立 Domain → Direction 层级；方向数量稳定超过约 15–20 个后再评估。
- 首发不实现自动接受或基于 confidence 的静默写入。
- 首发不实现完整 Topic Wiki、KnowledgeRevision 的 `global-curated` indexing，或图谱浏览。
- 首发不把任意技术、arXiv category 或关键词直接转换为方向。
- 首发不定义 Model、Method 或 Dataset 实体。
- 首发不清理或覆盖生产 vault 中未知形态的 legacy `topics:`。

## 3. Core model and invariants

### 3.1 Paper Alias

Paper Alias 是可以在日常交流中指代整篇 Paper 的人类友好名称。
模型或方法名只有在能够指代整篇 Paper 时才成立；论文内的模型变体不自动成为 Alias。

Canonical Paper frontmatter 的目标形态为：

```yaml
aliases:
  - name: GenCeption
    kind: model-name
    preferred: true
```

Alias invariants:

- 一个 Paper 可以有多个 Alias，但最多一个 `preferred: true`。
- 同一 Paper 内按 normalized key 去重。
- Alias normalized key 与 canonical title 相同的条目不保存。
- `kind` 取 `model-name | method-name | acronym | project-name | user-defined`。
- Alias 依附于 Paper，而不是 Paper Version；新版本不会静默删除旧 Alias。
- 全库 Alias 不要求唯一；Preferred collision 产生非阻断警告。
- `source`、`confidence` 和 Agent `rationale` 不进入 canonical Markdown，保留在 Proposal、
  ReviewDecision 和 Agent Run 审计中。

### 3.2 Research Direction

Research Direction 是 active Topic 承担的导航角色，不是新实体。
一个 Topic 在满足以下条件时可以被 Direction assignment 引用：

- Knowledge Node 的 `node_type = topic`；
- lifecycle 为 active；
- 存在 active、confirmed Topic revision；
- revision 有有效 title 和非空 Scope；
- `aliases` 字段存在，但允许为空。

Research Direction 按 Paper 的核心研究问题或贡献判定。技术、模型家族、
arXiv category 和标题关键词只能作为输入信号。

### 3.3 Topic usage level

`usage_level` 属于 Topic revision，而不是 Topic identity：

| Level | Required content | Retrieval visibility |
|---|---|---|
| `classification` | title、aliases 字段、非空 Scope | 仅用于 Paper Catalog 和分类 |
| `knowledge-ready` | 具有可复用的实质知识内容，并经用户明确确认 | 可作为未来 `global-curated` 知识来源 |

默认值为 `classification`。Confirmation 与 retrieval eligibility 是两个独立维度：
classification-only Topic 是已确认的有效方向，不是 Draft 或低可信知识。
首发所有方向都仅用于分类；等完整 Topic 知识页能力出现后，用户才可以显式将某个
revision 标记为 `knowledge-ready`。

### 3.4 Direction assignments

Canonical Paper frontmatter 的目标形态为：

```yaml
directions:
  - topic_id: topic:vision-representation-learning
    role: primary
  - topic_id: topic:video-generation
    role: secondary
```

Assignment invariants:

- 每个 Paper 至多一个 Primary。
- 每个 Paper 至多三个 Secondary。
- Paper 要么没有任何 confirmed Direction，要么有一个 Primary；Secondary 不能在没有
  confirmed Primary 时单独存在。
- 同一 Topic 在 redirect resolution 后不能同时出现两次。
- Primary 决定 Paper Library 中唯一的主要归组。
- Secondary 参与搜索、方向过滤和相关论文展示，但不造成主列表重复。
- Assignment 属于 Paper，Paper Version 更新不静默改变它。
- 没有 confirmed Primary 的 Paper 是 Unclassified。
- Assignment 只能引用 direction-usable Topic。

Secondary 采用统一三问判据：

1. 论文主要回答的核心问题属于哪个方向？该方向是 Primary。
2. 某方向的研究者是否会因为这篇论文更新对该方向的认知？如果是，可作为 Secondary。
3. 如果理由只是“论文使用了 X”，X 不是 Secondary。

方向建议的 `rationale` 必填。对于
*Video Generation Models are General-Purpose Vision Learners*：

- Preferred Alias：`GenCeption`；
- Primary：Vision Representation Learning；
- Video Generation 只有在理由明确指出论文改变了对视频生成模型能力边界的理解时，
  才可成为 Secondary。

## 4. Authority and write lifecycle

### 4.1 Authority

| Data | Authority |
|---|---|
| confirmed Paper aliases and direction assignments | Paper Markdown frontmatter |
| Topic title、aliases、Scope、curation level、supersession | Topic revision Markdown |
| Proposal、ReviewDecision、Agent/Job Run、KWR phase | SQLite |
| Paper Catalog、exact lookup table、direction counts、redirect lookup | rebuildable SQLite projection |

Topic 页中的 “Representative papers” 是编辑精选，不是全部成员关系的第二事实源。
完整成员关系只从 Paper manifests 的 `directions:` 派生。

### 4.2 Proposal types

新增两个业务 Proposal type，不增加第二个 generic discriminator column：

#### `paper-organization`

- `target_kind = paper`
- payload `change_kind = alias | primary-direction | secondary-direction`
- payload 包含 operation、before/after 值、候选对象和适用的 rationale
- Alias rationale 可选；Primary/Secondary rationale 必填

典型 operation：

- Alias：`add | remove | set-preferred`
- Primary：`set | replace | remove`
- Secondary：`add | remove | replace`

#### `direction-taxonomy`

- `target_kind = topic`
- payload `operation = create | rename | merge | scope-edit`
- create/rename/scope-edit 包含目标 title、aliases、Scope 和 rationale
- merge 包含 source、target、Scope compatibility 说明和受影响 Paper 预览

Agent 建议、批量整理和用户直接编辑共用同一 envelope。用户直接编辑不增加第二次确认：
UI 提交后立即进入同一 application lifecycle，Proposal 只作为审计和恢复 envelope。

### 4.3 UI split, governance shared

“UI 分流，纪律不分流”是硬约束：

- 轻量组织建议主要出现在 `/papers/organize` 和 Paper Workspace；
- Review Center 可按类型查看这些 Proposal，但默认高风险知识队列和计数不被其淹没；
- storage、ReviewDecision、idempotency、KWR 和恢复语义完全共用；
- Paper card 分别显示 `pendingOrganizationCount` 与高风险 `pendingReviewCount`。

### 4.4 Acceptance ordering

沿用现有 Option E：

```text
user accepts or submits direct edit
  → reserve one KnowledgeWriteRequest
  → render and validate staged Paper/Topic Markdown
  → revalidate referenced Topic lifecycle and redirect preconditions
  → atomic canonical rename
  → one SQLite metadata transaction:
       update Proposal to accepted
       insert immutable ReviewDecision
       update projection metadata and index outbox
       mark KWR metadata-committed
  → update/rebuild projections
  → complete
```

Consequences:

- metadata commit 前失败或冲突：Proposal 保持 pending，不产生 accept ReviewDecision；
  KWR 记录 failed/conflicted，并提供显式 retry 或替代 Proposal。
- metadata commit 后失败：confirmed Markdown 和 ReviewDecision 已成立，只剩可恢复的
  projection/index 工作。
- 同一 Proposal 至多有一个 non-terminal KWR。
- 同一 Paper/Topic target path 的 KWR 必须串行。
- retry 复用原 Proposal 与稳定 idempotency identity，不静默重新分类。

## 5. Paper Catalog and search

### 5.1 Projection boundary

Paper Catalog 是独立的 rebuildable projection，不能复用或污染 `global-curated`。
它从 hash-verified Paper/Topic Markdown 构建：

- Paper canonical title、authors、year 和 external identities；
- Paper Alias、Preferred flag、kind 和 normalized key；
- confirmed Primary/Secondary assignments；
- direction title、aliases、Scope、curation level；
- active Topic redirect closure；
- processing、reading 和 pending organization 状态的 operational join。

建议 projection 分为：

- one-row-per-Paper catalog document；
- one-row-per-Alias exact lookup；
- Paper-to-Direction assignment projection；
- active direction catalog；
- Topic redirect projection；
- trigram FTS，用于 title、alias、author 和 direction 的模糊查询。

Exact alias lookup 使用 normalized-key 等值表，不依赖 FTS rank。

### 5.2 Alias normalization

用于匹配的 normalized key 按固定顺序生成：

1. Unicode NFKC；
2. trim；
3. 连续 whitespace collapse 为一个空格；
4. Unicode-aware case folding。

Markdown 保留用户输入的 display spelling。Normalization 版本写入 projection metadata，
以便算法变化后确定性重建。

### 5.3 Ranking and disambiguation

Paper Catalog 默认排序优先级：

1. exact External Identity；
2. exact Preferred Paper Alias；
3. exact non-preferred Paper Alias；
4. exact canonical title；
5. title/alias prefix；
6. trigram relevance across title、alias、author、direction；
7. recent activity 作为同分 tie-breaker。

Search result 必须显示命中原因。Alias 命中至少显示：

- matched Alias；
- canonical title；
- authors/year；
- Primary Research Direction；
- collision warning when relevant。

短 Alias 不被禁止，但发生碰撞时不能自动打开唯一 Paper。

### 5.4 Entry Agent boundary

Alias 本身不是知识证据。Entry Agent 集成分两步：

1. Paper Resolver 使用 Catalog 将 Alias 解析为一个或多个 Paper candidates；
2. Agent 仍只从这些 Paper 的 active Summary 和 confirmed knowledge 中取证。

出现 collision 时不得静默选择；首发可以只在 Paper Library 启用 Catalog search，
Entry Agent alias resolution 作为后续兼容切片。

## 6. Interaction design

### 6.1 Paper Library

Desktop 左侧导航显示：

- 全部；
- 未分类；
- 待确认；
- active Research Directions 及 Primary count；
- 管理方向 / 整理论文入口。

点击方向后：

- “主要归属”区展示以该方向为 Primary 的 Papers；
- “相关方向”区展示仅以该方向为 Secondary 的 Papers；
- Paper 不会在“主要归属”中重复；
- Secondary match 数量与 Primary count 分开显示。

Pending Organization 是 overlay/filter，不是互斥分类：

- `Unclassified`：没有 confirmed Primary；
- `Pending Organization`：存在 open `paper-organization` Proposal；
- 同一 Paper 可以同时属于二者。

URL-restorable state：

```text
/papers?view=all|unclassified
       &direction=:topicId
       &relation=all|primary
       &pending=true|false
       &q=:query
```

无效或 superseded Topic ID 通过 canonical redirect 解析；redirect loop 或不存在的目标显示
明确错误，不静默返回“全部”。

窄屏下左侧导航变为全宽 drawer；当前方向、query 和 overlay filter 保持在 URL 中。

### 6.2 Paper card and Workspace

存在 Preferred Alias 时：

```text
GenCeption
Video Generation Models are General-Purpose Vision Learners
Vision Representation Learning · Video Generation
```

- Preferred Alias 是主显示名，canonical title 是副标题。
- 没有 Preferred Alias 时仍以 canonical title 为主。
- Direction chip 区分 Primary 与 Secondary。
- Workspace persistent header 提供“编辑别名与方向”drawer。
- 保存中、已保存、冲突/可重试必须是可见状态。

### 6.3 Organization workspace

`/papers/organize` 负责低摩擦策展：

- 候选方向的创建、合并、改名和 Scope 编辑；
- Paper assignment 与 Alias 建议；
- 按方向、confidence、冲突和未分类状态分组；
- 每项接受/编辑/拒绝；
- 批量操作前显示影响数量和样本；
- 批量结果按 Paper 展示 succeeded、failed、conflicted 和 retry；
- 不提供覆盖未知 Markdown 或跳过 hash conflict 的“强制完成”。

## 7. Automation

### 7.1 Existing-library bootstrap

流程分两阶段，不能边聚类边写入：

1. 从 active Summary 中抽取每篇 Paper 的核心问题、贡献和候选 Alias。
2. Agent 生成小规模候选 taxonomy，包含名称、aliases、Scope、排除边界、代表 Paper IDs 和 rationale。
3. 用户合并、改名、编辑 Scope 并确认 classification-only Topics。
4. Agent 只针对已确认 Research Directions 生成逐 Paper Primary/Secondary Proposal。
5. 用户批量接受高一致性建议并单独处理歧义项。

首轮目标是少量稳定方向，而不是覆盖每个技术关键词。没有合适方向的 Paper 保持
Unclassified，并可产生独立 `direction-taxonomy` 建议。

### 7.2 New Paper

Paper Summary 成为 active 后可启动独立 organization Job：

- 生成一句核心研究问题；
- 生成一句主要贡献；
- 在 confirmed Research Directions 中排序 Primary 候选；
- 给出至多三个符合三问判据的 Secondary 候选；
- 提取能指代整篇 Paper 的 Alias candidates；
- 生成 `paper-organization` Proposals，或持久化 `no-fitting-direction` outcome。

Organization Job 失败不影响 Summary 阅读和 Paper Workspace。Retry 固定输入的
Paper Version、Summary Revision、direction catalog hash、prompt/schema hash。

### 7.3 Future calibration

首发所有建议均需用户确认，不以模型 confidence 自动接受。ReviewDecision 反馈可以用于
离线评估，但自动化必须另行通过质量门禁。

未来 auto-accept 即使启用也必须：

- 只作用于新 Paper 的首次分类或明确白名单操作；
- 永不改变 confirmed Primary；
- 产生可审计 policy decision；
- 可一键撤销；
- 在方向 Scope 或分类 prompt 改变后重新校准。

## 8. Topic rename and merge

### 8.1 Rename

Rename 创建新 Topic revision，Topic ID 不变。Paper assignments 无需改写，
Catalog rebuild 后使用新 title/aliases。

### 8.2 Merge

Merge 采用 source → target：

1. source Topic 的 canonical revision 记录 `superseded_by: :targetTopicId`；
2. redirect projection 从 Topic Markdown 确定性重建；
3. reads 在 projection 层解析 A→B→C closure，并检测 loop；
4. 后台逐 Paper 创建 recoverable KWR，把 source assignments 迁移到 target；
5. Primary/Secondary 指向同一 target 时 Primary 保留，duplicate Secondary 删除；
6. merge 不会增加 Secondary 数，不执行 silent truncation；
7. Scope、代表论文、分歧和其他编辑性内容不自动拼接，必须单独策展；
8. migration 未完成或单 Paper 冲突时，旧 ID 继续通过 redirect 可读。

任何建议在接受前都重新校验 Topic 未 superseded/deleted；不得静默 retarget Proposal。

## 9. Legacy `topics:` migration

生产 vault 是外部权威，正式迁移前必须只读检查：

- `topics:` 是否有非空值；
- 值是 title、slug、wikilink、Topic ID 还是混合形态；
- Paper、Concept、Question 和 Synthesis 中是否具有不同语义；
- 外部编辑是否留下未知 YAML 字段或顺序依赖。

在检查完成前：

- 新功能写入 `aliases:` 和 `directions:`；
- legacy `topics:` 原样保留；
- parser/serializer 必须 round-trip 未知内容；
- 不把 legacy `topics:` 自动解释为 Primary；
- 不执行删除、覆盖或批量迁移。

迁移必须作为独立切片，满足幂等、hash 验证、零未知内容丢失和可恢复冲突。

## 10. Implementation sequence

Implementation status (2026-07-31): Slice 1 is implemented in the application.
Slices 2–4 remain intentionally deferred; in particular, `/papers/organize`, Agent taxonomy
bootstrap/backfill, batch decisions, Topic rename/merge commands, production legacy migration,
and auto-accept are not part of the first implementation commit.

### Slice 1 — Manual organization foundation

- minimal Topic/Topic revision runtime with `classification` usage level；
- Paper `aliases:` / `directions:` parser、validator、writer；
- Paper Catalog、exact alias lookup、trigram search、projection rebuild；
- manual Paper/Direction commands and Option E KWR lifecycle；
- Paper Library navigation、search、card display 和 Workspace editor；
- high-risk pending review 与 pending organization 分离计数。

### Slice 2 — Organization proposals and backfill

- `paper-organization` / `direction-taxonomy` Proposal handlers；
- `/papers/organize`；
- taxonomy bootstrap Agent Job；
- per-Paper classification/Alias proposals；
- batch accept with per-Paper KWR outcomes；
- rename、merge、redirect closure 和 partial migration。

### Slice 3 — Legacy migration

- production vault read-only inventory；
- versioned migration plan；
- dry run、snapshot、hash verification；
- migration into a new temporary root before production application；
- explicit owner approval before any destructive cleanup.

### Slice 4 — Deferred automation and knowledge integration

- calibrated auto-accept policy；
- Entry Agent Alias resolver；
- knowledge-ready Topic KnowledgeRevision indexing；
- optional Domain → Direction hierarchy。

Implemented as four independently reviewed slices: calibrated auto-accept (4A),
Entry Alias resolver (4B), knowledge-ready Topic revisions (4C), and the optional
exactly two-level Domain → Direction navigation hierarchy (4D)。

## 11. Acceptance and verification

### 11.1 Domain and storage

- parser rejects more than one Primary, more than three Secondary, duplicate normalized Alias,
  Secondary without Primary, duplicate redirected Direction, and references to
  non-direction-usable Topic。
- aliases and assignments survive process restart, index rebuild, snapshot and restore。
- external Markdown conflict never gets overwritten；KWR becomes conflicted and Proposal remains pending。
- failure injection covers reserved、staged、renamed、metadata-committed and indexed。
- one Proposal cannot own two non-terminal KWRs。
- per-Paper batch failures do not roll back already completed Papers or hide failed items。

### 11.2 Search

- `GenCeption` exact Alias finds the expected Paper before fuzzy title matches。
- NFKC、casefold、whitespace、hyphen/CJK/Latin fixtures produce deterministic results。
- collision results show matched Alias and disambiguation metadata。
- Catalog rebuild from authoritative Markdown produces byte-equivalent logical rows and counts。
- `global-curated` contents do not change when only Alias/Direction metadata changes。

### 11.3 Interaction

- All、Unclassified、Pending 和 Direction URL states survive refresh/back/forward。
- Direction view distinguishes Primary count and Secondary matches。
- Paper appears once in Primary grouping。
- Preferred Alias/canonical title hierarchy is readable on wide and narrow screens。
- organization drawer and `/papers/organize` expose saving、success、failure、conflict and retry。

### 11.4 Required verification

Before completing each implementation slice:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Storage slices also verify snapshot and restore into a new temporary root.
Browser slices complete a real Playwright journey.

## 12. Remaining unknowns

Only the production vault's legacy `topics:` shape remains an external unknown.
It blocks Slice 3 migration design, but does not block the core model, manual foundation,
Paper Catalog, or organization Proposal lifecycle.
