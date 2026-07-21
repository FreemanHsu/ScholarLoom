export type EvidenceInspectorModel = {
  id: string;
  evidenceKind: "pdf" | "summary" | "code" | "library" | "visual";
  sourceId: string;
  sourceRevision: string | null;
  workspacePath: string;
  quote: string;
  verificationStatus: string;
  locator: Record<string, unknown>;
};

export function EvidenceInspector({ evidence, onClose }: { evidence: EvidenceInspectorModel; onClose(): void }) {
  const locator = evidence.evidenceKind === "pdf" ? `Page ${String(evidence.locator.page ?? "?")}`
    : evidence.evidenceKind === "code" ? `${String(evidence.locator.path ?? evidence.workspacePath)}:${String(evidence.locator.lineStart ?? "?")}-${String(evidence.locator.lineEnd ?? "?")}`
      : evidence.workspacePath;
  return <aside className="evidence-inspector" aria-label="Verified Evidence">
    <header><div><span className="eyebrow">VERIFIED EVIDENCE</span><h2>{evidence.evidenceKind.toUpperCase()}</h2></div>
      <button aria-label="关闭证据" onClick={onClose}>×</button></header>
    <blockquote>{evidence.quote}</blockquote>
    <dl><dt>Source</dt><dd>{evidence.sourceId}</dd><dt>Revision</dt><dd>{evidence.sourceRevision ?? "固定内容 hash"}</dd>
      <dt>Locator</dt><dd><code>{locator}</code></dd><dt>Status</dt><dd>{evidence.verificationStatus}</dd></dl>
  </aside>;
}
