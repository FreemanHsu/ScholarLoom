# ScholarLoom

一个面向个人论文阅读、知识沉淀与交互式问答的 AI-native 知识库。

这里把外部数据目录中的 Markdown 当作长期事实源：论文笔记记录证据，概念笔记沉淀可复用知识，
主题地图负责导航，问题笔记追踪未知，综合文章形成跨论文观点。未来的全文检索、
向量检索、知识图谱或 Web UI 都应从这些文件派生，而不是取代它们。

## 从这里开始

1. 把论文链接、DOI、PDF 路径或临时想法放进数据 vault 的 `inbox/README.md`。
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

## 核心原则

- 原始论文优先于摘要，证据优先于结论。
- 论文笔记不是终点；可复用的认识要进入概念、主题和问题网络。
- AI 推断、作者主张和个人判断必须明确区分。
- 所有检索索引和交互界面都可以重建，Markdown 不可被派生数据库替代。

## 当前阶段

第一条纵向切片已经实现：arXiv → PDF.js page extraction → Evidence Anchor →
Skill 驱动的 Codex Summary → 固定 Git commit → Paper Conversation → 已确认
Takeaway → curated-only Entry Agent。系统使用 React/Vite、Fastify、SQLite FTS5 与
Codex CLI，不引入向量数据库。

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

`diagnostics` 是只读的，报告 migration 版本、SQLite integrity/foreign-key check、
中断 Job、未完成知识写入、缺失 Artifact/Markdown 和待处理索引。`rebuild-index` 会只从
active Paper Summary 与 confirmed Takeaway 确定性重建 `global-curated` FTS；PDF、Message
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

生产模式使用 arXiv Atom/PDF、真实 `git clone` 和：

```text
codex exec --sandbox read-only --ephemeral --output-schema <schema> \
  --output-last-message <result> -
```

应用向 Codex 提供 opaque source handle manifest，校验结构化结果与 Evidence Anchor 后才
写入。运行 `npm start` 后导入一篇允许下载的 arXiv 论文即可做 opt-in smoke；这会使用
网络和 Codex 配额。仓库不会自动安装依赖或执行论文代码，也不会提交下载的 PDF/runtime
assets。
