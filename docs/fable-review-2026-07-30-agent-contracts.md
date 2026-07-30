# Agent Prompt 与输出契约 Fable 评审

日期：2026-07-30  
评审模型：`claude-fable-5`  
配置版本：`agent-configuration.v2`

本轮将五个 Agent 分成独立 Canvas 评审：Paper Summary、Agentic Evidence、Entry
Agent、Takeaway Selection 与 legacy Paper Chat。发送给外部评审的内容仅包含仓库内
Prompt、JSON Schema、产品约束和确定性校验边界；未发送论文正文、Vault、运行时问题、
环境变量或 secret。每条轨道均经过初审、约束反驳和最终收敛。

## 共同结论

- Prompt 负责来源边界、话语归因、abstention、冲突表达与 Selection 判断纪律。
- Runtime JSON Schema 负责 closed object、枚举、allowlist、长度、数量和唯一性。
- Host validator 只强制可确定验证的跨字段关系，不把语义判断伪装成确定性规则。
- 无效 handle、locator、Evidence Receipt 或状态组合必须 fail closed；不得过滤坏引用后
  继续保存回答。
- 配置页继续直接展示执行链路所用 Prompt 与 Schema，不维护第二份展示副本。

## 各 Agent 决策

### Paper Summary

- 新生成 Summary 使用固定 section keys；五个核心 section 必需，training/inference
  仅在适用时出现。
- 新生成 Key Claim 只允许 `authors-claim` 与 `paper-evidence`。Agent 独立评价留在
  section body 并显式标注；旧数据中的 `agent-assessment` 仍可读取，不迁移。
- Runtime Schema 收紧 PDF handle；runner 校验 section 唯一、顺序、必选覆盖、body
  marker allowlist，以及方法/实验 section 的最低引用覆盖。

### Agentic Evidence

- Prompt 明确轻量 `search → verify → answer`，Conversation 仅作 context，Visual
  Evidence 只在文本不足时按需使用。
- `answered` / `partially_answered` 至少一个 verified Receipt；
  `insufficient_evidence` 恰好零个；`conflicting_evidence` 至少两个不同位置。
- Receipt 基数在 Evidence Gate 完成后由 Coordinator 校验，不能用未核验 citation
  满足状态条件。

### Entry Agent

- 增加机器可读 `answerStatus`，避免用固定中文拒答前缀承载不变量。
- `answered`、`partially_answered`、`insufficient_evidence` 与
  `conflicting_evidence` 分别约束来源数量及 `uncertainty` 的 null/non-null 语义。
- Prompt 区分 Summary 转述、confirmed Takeaway 与 Agent synthesis；confirmed
  表示用户确认进入长期知识，不表示客观真理。

### Takeaway Selection

- 保持 `takeaway-selection.v2` 字段、枚举和 lifecycle 不变。
- `multiple-claims` 只表示最佳候选自身无法收敛为一个 atomic conclusion，不能表示
  “候选太多”。
- Hypothesis 的 Receipt 证明 provenance/motivation，不证明命题为真；hypothesis
  必须有明确 caveat。
- Comparison 的 baseline、metric 与条件属于 claim 的 truth conditions，不能藏在
  caveat 或 focus。疑似重复只写 `duplicateHints`，由下游 Review 决定。

### Legacy Paper Chat

- 保持 `answer + citations` 字段兼容，不增加 status。
- 每次运行按 manifest handles 生成动态 Schema；Host 严格校验
  `(sourceHandle, locator)` 与输入 source 完全一致，并拒绝重复。
- 空 citations 的“资料不足”语义因缺少 status 无法确定验证，只由 Prompt 与 evaluation
  约束；Host 不使用脆弱文案匹配。

## 未采纳建议

- 不增加 confidence、模型二次判分、自动语料过期、额外检索或新的 UI 字段。
- 不用随机 XML 标签包裹已经 JSON 序列化的 context。
- 不把 comparison coverage、atomicity、指代消解或 citation faithfulness 当作 Host
  可以确定理解的规则；这些保留在 Prompt、fixture 与人工抽检层。
- 不为本轮引入 repair pass 或数据迁移。
