# ScholarLoom

一个面向个人论文阅读、知识沉淀与交互式问答的 AI-native 知识库。

这里把外部数据目录中的 Markdown 当作长期事实源：论文笔记记录证据，概念笔记沉淀可复用知识，
主题地图负责导航，问题笔记追踪未知，综合文章形成跨论文观点。未来的全文检索、
向量检索、知识图谱或 Web UI 都应从这些文件派生，而不是取代它们。

## 从这里开始

1. 在应用中提交 arXiv 链接或公开 HTTPS PDF 直链；其他论文线索和临时想法可放进
   数据 vault 的 `inbox/README.md`。
2. 让 AI “摄取这篇论文”，它会根据 [`templates/paper.md`](templates/paper.md)
   创建规范化论文笔记并连接概念与主题。
3. 从 `$HOME/ScholarLoomData/vault/HOME.md` 浏览当前阅读、开放问题和近期综合。
4. 直接提问，例如：
   - “知识库里关于 RAG 评估有哪些共识和争议？”
   - “对比这三篇论文的方法、数据和局限。”
   - “把刚才的回答沉淀为一个 synthesis。”

AI 的完整工作协议见 [`AGENTS.md`](AGENTS.md)。

已固化的 MVP 产品范围见 [`docs/PRD.md`](docs/PRD.md)。

v1 数据层级、不变量和生命周期见 [`docs/data-model.md`](docs/data-model.md)，
统一领域术语见 [`CONTEXT.md`](CONTEXT.md)。

系统模块与运行拓扑见 [`docs/architecture.md`](docs/architecture.md)，第一条纵向切片见
[`docs/implementation-slice-001.md`](docs/implementation-slice-001.md)，外部设计评审记录见
[`docs/fable-review-2026-07-19.md`](docs/fable-review-2026-07-19.md)。

Paper Alias、Research Direction、Paper Catalog 与组织建议的正式功能设计见
[`docs/paper-organization-feature-design.md`](docs/paper-organization-feature-design.md)。

开发分支、回主线门槛和紧急修复规则见
[`docs/development-workflow.md`](docs/development-workflow.md)。

## 核心原则

- 原始论文优先于摘要，证据优先于结论。
- 论文笔记不是终点；可复用的认识要进入概念、主题和问题网络。
- AI 推断、作者主张和个人判断必须明确区分。
- 所有检索索引和交互界面都可以重建，Markdown 不可被派生数据库替代。

## 当前阶段

第一条纵向切片已经实现：arXiv / 安全公开 PDF 直链 → PDF.js page extraction → Evidence Anchor →
Skill 驱动的 Codex Summary → 固定 Git commit → Paper Conversation → 已确认
Takeaway → curated-only Entry Agent。系统使用 React/Vite、Fastify、SQLite FTS5 与
Codex CLI，不引入向量数据库。

二级导航的 `/settings` 提供只读配置总览。页面与执行链路共享同一份应用内 Agent
配置注册表：Paper Summary 使用 `gpt-5.6-sol` / `high`，Agentic Evidence、Entry Agent、
Takeaway Selection 和 legacy Paper Chat 使用 `gpt-5.6-sol` / `medium`。页面还展示
application-owned Prompt、Skill、JSON Schema 与有界系统参数，不展示运行时问题、
论文/Vault 内容、secret 或环境变量。Codex CLI `0.144.6` 是最低支持版本；更高版本在
全部 capability canary 通过后自动接收，否则 fail closed。

当前 `agent-configuration.v4` 在五条既有 Fable 评审轨道外新增 Paper Organization Agent，
并使用 ChatGPT 账户支持的完整 Codex 模型 ID：
Summary 使用 canonical sections，Agentic Evidence 在 verified Receipts 后复核状态，
Entry Agent 返回机器可读 evidence status，Takeaway v2 强化 hypothesis/atomicity
纪律，legacy Paper Chat 使用 runtime handle/locator allowlist。

Paper Workspace 现包含可恢复的 Reading、Discussion 与 Knowledge 模式。
Conversation 使用稳定 URL 和不可变 Context Snapshot；Message、Agent attempt、
引用与 Takeaway Proposal 可在刷新或重启后恢复。失败和中断只允许显式 retry，
不会在启动时静默重跑。

Discussion 已使用 Codex-native Agentic Evidence Retrieval。每次 Attempt 运行一个
`codex exec`，在只读、content-addressed Evidence Workspace 内用 shell/`rg`/文件阅读
自主定位冻结的 PDF extraction、Summary、固定 commit、近期 Conversation context 与
创建时冻结的 curated library。最终引用必须带逐字 quote，并通过 MANIFEST、hash、路径和
行号校验后才生成 Evidence Receipt；Activity 只用于进度/audit。默认跨 Conversation
并发 2，支持 durable queue、cancel、timeout、restart-interrupted 与显式 retry。

Paper header 的“代码仓库”入口显示当前 Repository Associations。用户可输入明确的
GitHub repository root URL；系统规范化 identity、幂等复用现有关联，并异步固定当时的
commit。系统不从论文内容自动建立或建议 repository association。用户可移除当前关联，
其历史 identity、snapshot 和审计记录仍保留；再次手动添加同一 URL 会恢复关联。
物化失败可单独 retry，不影响 Paper 阅读；已冻结 Conversation 的 Repository Snapshots
永不追随 Paper 当前关联变化。

## 本地运行

要求 Node.js 22+、Git 和已完成登录的 Codex CLI。

```bash
npm install
npm run build
npm run data:init
npm run migrate
npm start
```

`data:init` 默认创建 `$HOME/ScholarLoomData`。生产启动不会静默创建数据目录，
也不会退回仓库内的 `.scholarloom/`。可用 `SCHOLARLOOM_DATA_ROOT` 显式选择另一已初始化根目录。

公开 PDF 获取默认采用 direct-first。可显式配置无凭据的 loopback HTTP CONNECT proxy：

```bash
SCHOLARLOOM_PDF_PROXY=http://127.0.0.1:7890 npm start
```

未设置时，应用只会继承同样满足安全约束的 `ALL_PROXY`/`all_proxy`。代理仅在直连发生
`ECONNRESET`、网络不可达、连接拒绝、连接超时或下载中途 reset 时作为一次 fallback；
HTTP 状态、TLS 证书、redirect、大小和 PDF 校验错误不会改走代理。CONNECT authority
使用已经过公网校验并固定的目标 IP，TLS SNI 仍使用原域名。`/settings` 展示 effective
策略与配置来源，但不会显示代理地址或凭据。

原文阅读默认使用 Chromium native PDF viewer。可显式启动尚未发布的 PDF.js reader
spike；它用于评估无闪烁 Evidence 跳页、fit-width 与加载反馈，不应视为默认阅读器：

```bash
SCHOLARLOOM_PDF_VIEWER=pdfjs npm start
```

当前 spike 是 canvas-only，尚未提供文本选择、搜索、打印和完整 accessibility；加载或
渲染失败时会自动降级 native viewer，新窗口打开原文始终保留。

对应 browser journeys 为 `npm run test:browser:pdfjs` 和
`npm run test:browser:pdfjs:large`；后者使用独立的 12 MiB、可重建 fixture，不读取
生产 PDF。

可选的 lossless delivery pipeline 使用 qpdf 把大于等于 1 MiB、尚未 linearized 的
原文生成到 `derived/pdf-delivery`。先安装 qpdf，再显式启用：

```bash
brew install qpdf
SCHOLARLOOM_PDF_OPTIMIZATION=lossless-linearization npm start
```

原始 PDF 始终保留在 `originals/` 且不被修改；工具缺失、输出校验失败、页数变化或
体积膨胀超过 2% 时继续交付 original。默认 snapshot 不包含优化版，恢复后会从
original 自动重建。该开关与 `SCHOLARLOOM_PDF_VIEWER` 相互独立。
关闭开关后，Workspace 与版本跳转会立即恢复交付 original；既有 derived 文件仍只是
可重建缓存，不会因曾经生成过而绕过 opt-in。
真实 throttled browser journey 可用 `npm run test:browser:pdfjs:linearized` 运行。
固定的真实 Paper Version corpus 可用 `npm run benchmark:pdf-delivery` 运行；它只在
系统临时目录保存下载内容，输出 ignored JSON 报告，不读取生产 data root。当前结论与
复现步骤见 [PDF Delivery Corpus Benchmark](docs/benchmarks/pdf-delivery-corpus-2026-08-05.md)。

应用只监听 `127.0.0.1:3000`。本地 fixture 旅程不访问 arXiv 或 Codex，仍使用真实
SQLite、filesystem、PDF.js 和 Git：

```bash
SCHOLARLOOM_FIXTURE=1 SCHOLARLOOM_DATA_ROOT=/tmp/scholarloom-fixture npm start
```

开发时分别运行 `npm run dev:server` 与 `npm run dev`。Vite 只绑定 loopback，并把
`/api` 代理到 Fastify。

## 测试与运维

```bash
npm test
npm run typecheck
npm run build
npm run diagnostics
npm run rebuild-index
```

生产启动和新导入会检查 authoritative directories 是否可写。若 diagnostics 报告
`unwritablePaths`，先停止服务，再运行：

```bash
npm run data:repair-permissions
```

该命令把数据目录恢复为 owner-writable，同时保持 `originals/` 中的源文件只读；它不会
删除或重写知识内容。失败或中断的 Paper Import 会保留原 Job Run：来源获取失败可重试下载，
已安全保存的 PDF 会按 content hash 冻结并复用；进入 Paper workspace 后的 retry attempt
继续绑定原 Paper Version。系统只复用通过完整性检查的 PDF/解析产物，并优先恢复未完成的
KnowledgeWriteRequest。

## 数据快照与恢复

ScholarLoom 只负责生成一致性快照、校验和非覆盖恢复；当前不启用自动调度或远端传输。
创建快照前必须停止服务：

```bash
npm run backup -- /path/to/new-snapshot
npm run backup -- /path/to/new-snapshot-with-derived --include-derived
npm run backup:verify -- /path/to/new-snapshot
npm run restore -- /path/to/new-snapshot /path/to/new-empty-data-root
```

默认快照包含 `vault/`、`originals/`、SQLite Online Backup 与 SHA-256 manifest，
排除 `derived/`、`cache/`、`logs/` 和 `tmp/`。恢复永不覆盖现有数据根。

Legacy Paper `topics:` 迁移采用只读 inventory、显式 mapping 和 copy-first 执行，
不会把旧值猜成 Primary/Secondary，也不会原地修改或清理生产 root。所有报告、mapping
和 plan 都可能包含相对路径，只能保存在仓库外：

```bash
npm run data:paper-topics -- inventory /path/to/data-root /tmp/topics-inventory.json
npm run data:paper-topics -- plan /path/to/data-root /tmp/topics-inventory.json \
  /tmp/topics-mapping.json /tmp/topics-plan.json
npm run data:paper-topics -- migrate-copy /path/to/data-root /tmp/topics-plan.json \
  /path/to/new-empty-destination-root
```

`migrate-copy` 要求停止源服务、完整重验 inventory、创建并验证源 snapshot，再恢复到
不存在的 destination。它不授权 cutover，也不删除 legacy `topics:` 或旧 data root。

`diagnostics` 是只读的，报告 migration 版本、SQLite integrity/foreign-key check、
中断 Job、未完成知识写入、缺失 Artifact/Markdown、不可写目录和待处理索引。`rebuild-index` 会只从
active Paper Summary、confirmed Takeaway 与通过当前 provenance/attestation 校验的
knowledge-ready Topic 确定性重建 `global-curated` FTS；PDF、Message
与 Code Element 没有进入这个接口的路径。

## Tailscale Serve

先在 Mac mini 上启动 loopback 服务，再由 Tailscale Serve 提供 tailnet 私有 HTTPS：

```bash
tailscale serve --bg http://127.0.0.1:3000
tailscale serve status
```

不要使用 `tailscale funnel`，也不要把 `SCHOLARLOOM_HOST` 配成 `0.0.0.0`、LAN 或
Tailscale interface 地址；应用会拒绝这些配置。通过授权 tailnet 设备打开 Serve 输出的
HTTPS URL。`/api/events` 每 20 秒发送 heartbeat；事件先持久化，再以递增 ID 发送，客户端
重连时携带 `Last-Event-ID`。断流本身不表示 Proposal 已确认，也不会推进知识写入。

当前机器若未安装或未登录 Tailscale，只能完成 loopback 与配置拒绝测试，不能声称完成
真实 tailnet 连通性验收。

## 可选真实 smoke test

生产模式使用 arXiv Atom/PDF、安全公开 HTTPS PDF 下载、真实 `git clone` 和：

```text
codex exec --ephemeral --strict-config --output-schema <schema> \
  --output-last-message <result> -
```

Summary/Entry 继续使用各自的结构化 context；Discussion 使用单一 Codex-native custom
permission profile，把 shell 读取限制到 Evidence Workspace 与 minimal runtime、写入限制到
当前 Attempt 的私有 run directory，并关闭外网与 loopback。Visual Evidence 在同一个 exec
中通过仅含 `inspect_pdf_page`/`budget_status` 的 stdio MCP 按需渲染冻结 PDF 页面；Agent
不会获得原始数据根或任意路径。每次启动都执行同一 profile 的 capability canary；Visual
Evidence 要求 CLI 不低于 `0.144.6`，并在每次启动执行 capability canary；更高版本通过
全部 canary 后自动接收。任何 canary 失败都会 fail closed，不回退 legacy one-shot。运行
`npm start` 后导入一篇允许下载
的 arXiv 论文或公开 PDF 直链即可做 opt-in
smoke；这会使用网络和 Codex 配额。公开 PDF 仅接受 URL 直接返回的 PDF，不解析 landing
page、DOI、OpenReview 或登录态链接。仓库不会自动安装依赖或执行论文代码，也不会提交
下载的 PDF/runtime assets。
