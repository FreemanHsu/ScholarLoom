# ScholarLoom Documentation

本目录区分当前权威契约、支持性证据和历史实施记录。代码与文档冲突时，按
PRD、architecture、data model 和已接受 ADR 的顺序核对，并同步修正文档。

## 当前权威文档

- [产品需求](PRD.md)
- [系统架构](architecture.md)
- [数据模型](data-model.md)
- [SQLite schema](sqlite-schema.sql)
- [前端信息架构](frontend-information-architecture.md)
- [Paper Organization 功能设计](paper-organization-feature-design.md)
- [Knowledge Question 功能设计](knowledge-question-feature-design.md)
- [领域术语](../CONTEXT.md)
- [架构决策记录](adr/)

## 支持性证据

- [Benchmarks](benchmarks/)
- [Evaluations](evaluations/)
- [当前 backlog](backlog.md)
- [开发工作流](development-workflow.md)

## 历史记录

- [Implementation plans](plans/)：已经实施或用于拆分工作的纵向切片计划，不是当前行为的权威来源。
- [External review archive](archive/reviews/)：保留被采纳与拒绝建议的历史摘要；运行时 Canvas/node 标识不纳入仓库。

一次性截图、Playwright 输出和本机 QA session 日志不属于版本化文档。可复现行为应由自动化测试、
benchmark 或 ADR 记录。
