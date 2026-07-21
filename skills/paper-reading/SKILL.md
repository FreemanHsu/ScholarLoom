---
name: paper-reading
description: Analyze research papers, especially AI/ML papers, from attached PDFs, local PDF files, arXiv links, DOI/URL references, or paper text. Use when the user asks for a paper reading, paper analysis, technical paper summary, literature review style breakdown, or detailed Chinese explanation of a research paper's motivation, method, training/inference process, experiments, and limitations.
---

# Paper Reading

## Overview

Provide a comprehensive, technically accurate Chinese analysis of a research paper for readers with foundational AI/ML knowledge. Prefer evidence from the paper itself, clearly distinguish interpretation from stated claims, and explicitly note missing or ambiguous details instead of inventing them.

## Input Handling

1. Identify the paper source:
   - Attached PDF or local PDF path: read/extract the PDF first.
   - arXiv link or ID: fetch the abstract page and PDF when internet access is available; otherwise use any provided text and say what could not be fetched.
   - DOI, conference page, project page, or URL: use the canonical paper/PDF if available.
   - Plain text excerpt: analyze only the supplied content and call out coverage limits.
2. Extract bibliographic metadata from the paper or trusted source: title, authors, venue, and publication date. If venue or date is absent, say so explicitly.
3. Read enough of the paper to ground the analysis: abstract, introduction, related work, method, algorithm boxes, experiments, ablations, limitations, and appendices when relevant.
4. For claims, formulas, datasets, baselines, and metrics, prefer exact paper terminology. If making an inference, label it as an inference.
5. If the user requests "latest", "published venue", current arXiv version, or other potentially changing metadata, verify with browsing when available.

## Analysis Workflow

1. Skim for the thesis: What problem is being solved, what is the central idea, and what evidence is offered?
2. Build a compact mental model of the method: inputs, outputs, components, training objective, inference path, and where the novelty actually sits.
3. Map related work into contrasts, not just citations: explain what prior methods could not do and why this paper's change matters.
4. Trace the experiments back to claims: identify whether each major claim is supported by main results, ablations, analysis, or only asserted.
5. Evaluate limitations: use the authors' stated limitations plus your own technically grounded critique.
6. Produce the structured analysis in Chinese using the section template below.

## Output Template

Use this structure by default unless the user asks for a different format.

### 1. 论文概述 (Paper Overview)

- 论文标题、作者、发表 venue 和时间。
- 研究领域和主要贡献的一句话总结。
- 这篇论文试图解决什么问题？为什么这个问题重要？

### 2. 核心想法与动机 (Core Ideas and Motivation)

- 现有方法的局限性是什么？结合 Related Work 分析。
- 本文提出的核心创新点是什么？
- 关键 insight 或 intuition 是什么？
- 与之前工作的本质区别在哪里？

### 3. 方法详解 (Technical Implementation)

- 整体框架或架构设计。
- 核心算法、模型结构、训练目标或理论构造的详细解读。
- 关键公式推导和解释；用数学 notation 或代码块辅助说明。
- 重要设计选择及其原因。
- 任何 tricks、实现细节、工程假设或复现实用信息。

### 4. 训练流程 (Training Process)

Include this section when the paper involves model training, finetuning, optimization, data generation for training, or learned components.

- 训练数据：数据集、数据处理方式、过滤或采样策略。
- 损失函数设计及其含义。
- 优化策略：optimizer、learning rate schedule、batch size、训练步数等。
- 训练技巧：数据增强、正则化、预训练、蒸馏、curriculum、RL 等。
- 训练资源需求和时间成本。

If the paper does not involve training, skip this section as a full section and write one brief sentence after Section 3 explaining why.

### 5. 推理流程 (Inference Process)

Include this section when the paper describes prediction, decoding, planning, sampling, search, evaluation-time adaptation, deployment, or any test-time algorithm.

- 推理 pipeline 的详细步骤。
- 推理时的特殊处理或优化。
- 推理效率分析：速度、内存占用、复杂度、吞吐、延迟等。
- 与训练阶段的差异。

If the paper does not involve inference, skip this section as a full section and write one brief sentence explaining why.

### 6. 实验分析 (Experiments Analysis)

- 主要实验设置和 baseline 对比。
- 关键实验结果解读，包含指标、任务、数据集和相对提升。
- 消融实验揭示了什么？
- 实验是否充分验证了论文 claims？指出支持充分和不足之处。

### 7. 总结与思考 (Summary and Thoughts)

- 论文的主要贡献总结。
- 潜在局限性或不足。
- 可能的改进方向或未来工作。
- 对领域的影响和启发。

## Style and Rigor

- Write in Chinese by default, keeping paper-specific technical terms in English when they are standard or clearer.
- Write each structured section body as Markdown without repeating its section title. Nested headings start at `###`.
- Use `$...$` for inline LaTeX and place `$$` delimiters on their own lines for display LaTeX. Do not use `\\(...\\)`, `\\[...\\]`, or raw HTML.
- Put one or more `[pdf-page:N]` markers immediately after important methods, metrics, author conclusions, and limitations when those pages exist in the allowed source handles. Do not invent page numbers. If an Agent assessment has no direct page evidence, label it explicitly as an Agent assessment instead of presenting it as a Paper claim.
- Do not emit Markdown images. Use short fenced code blocks for pseudocode or notation when they are clearer than prose.
- Use precise terminology and explain novel paper-specific terms on first use.
- Be objective: include both strengths and weaknesses.
- Use equations, pseudocode, or short code blocks when they make the method clearer.
- Avoid unsupported certainty. Use phrases like "论文没有说明", "根据实验设置可推断", or "作者声称" where appropriate.
- Do not over-summarize. The expected output is a detailed technical reading, not a short abstract.
