import { useEffect, useState } from "react";

export type EvidenceInspectorModel = {
  id: string;
  evidenceKind: "pdf" | "summary" | "code" | "library" | "visual";
  sourceId: string;
  sourceRevision: string | null;
  workspacePath: string | null;
  quote: string | null;
  verificationStatus: string;
  locator: Record<string, unknown>;
  page?: number | null;
  visualObservation?: string | null;
  rendererName?: string | null;
  rendererVersion?: string | null;
  rendererFingerprint?: string | null;
  renderSettings?: Record<string, unknown> | null;
  imageHash?: string | null;
  imageUrl?: string | null;
};

export function EvidenceInspector({ evidence, onClose, onIntegrityFailure }: { evidence: EvidenceInspectorModel;
  onClose(): void; onIntegrityFailure?: (() => void) | undefined }) {
  if (evidence.evidenceKind === "visual") return <VisualEvidenceInspector evidence={evidence} onClose={onClose}
    onIntegrityFailure={onIntegrityFailure} />;
  const locator = evidence.evidenceKind === "pdf" ? `Page ${String(evidence.locator.page ?? "?")}`
    : evidence.evidenceKind === "code" ? `${String(evidence.locator.path ?? evidence.workspacePath)}:${String(evidence.locator.lineStart ?? "?")}-${String(evidence.locator.lineEnd ?? "?")}`
      : evidence.workspacePath ?? "Frozen source";
  return <aside className="evidence-inspector" aria-label="Verified Evidence">
    <InspectorHeader eyebrow="VERIFIED EVIDENCE" title={evidence.evidenceKind.toUpperCase()} onClose={onClose} />
    <blockquote>{evidence.quote}</blockquote>
    <dl><dt>Source</dt><dd>{evidence.sourceId}</dd><dt>Revision</dt><dd>{evidence.sourceRevision ?? "固定内容 hash"}</dd>
      <dt>Locator</dt><dd><code>{locator}</code></dd><dt>Status</dt><dd>{evidence.verificationStatus}</dd></dl>
  </aside>;
}

function VisualEvidenceInspector({ evidence, onClose, onIntegrityFailure }: { evidence: EvidenceInspectorModel;
  onClose(): void; onIntegrityFailure?: (() => void) | undefined }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [evidence.id, evidence.imageHash, evidence.verificationStatus]);
  const page = evidence.page ?? evidence.locator.page ?? "?";
  const available = !imageFailed && evidence.verificationStatus === "verified" && evidence.imageUrl;
  return <aside className="evidence-inspector visual-evidence-view" aria-label="Visual Evidence">
    <InspectorHeader eyebrow="VISUAL EVIDENCE" title={`Visual · p. ${String(page)}`} onClose={onClose} />
    {available ? <figure className="visual-page"><img src={evidence.imageUrl!} alt={`Frozen PDF page ${String(page)}`}
      onError={() => { if (!imageFailed) { setImageFailed(true); onIntegrityFailure?.(); } }} />
      <figcaption>Frozen PDF page · SHA-256 {shortHash(evidence.imageHash)}</figcaption></figure>
      : <div className="visual-integrity-warning" role="status">页面图像当前不可用：{imageFailed &&
        evidence.verificationStatus === "verified" ? "image-unavailable" : evidence.verificationStatus}</div>}
    <section className="visual-observation"><h3>Visual observation</h3><p>{evidence.visualObservation}</p></section>
    <dl><dt>Source</dt><dd>{evidence.sourceId}</dd><dt>Revision</dt><dd>{evidence.sourceRevision ?? "固定 PDF"}</dd>
      <dt>Renderer</dt><dd>{evidence.rendererName} · {evidence.rendererVersion}</dd>
      <dt>Settings</dt><dd><code>{JSON.stringify(evidence.renderSettings)}</code></dd>
      <dt>Fingerprint</dt><dd><code>{evidence.rendererFingerprint}</code></dd>
      <dt>Image hash</dt><dd><code>{evidence.imageHash}</code></dd><dt>Status</dt><dd>{evidence.verificationStatus}</dd></dl>
  </aside>;
}

function InspectorHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose(): void }) {
  return <header><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
    <button aria-label="关闭证据" onClick={onClose}>×</button></header>;
}

function shortHash(hash: string | null | undefined): string { return hash ? `${hash.slice(0, 12)}…` : "unavailable"; }
