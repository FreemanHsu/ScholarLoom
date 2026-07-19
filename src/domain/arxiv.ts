export type ArxivReference = {
  arxivId: string;
  explicitVersion: number | null;
};

const arxivUrlPattern = /^(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v(\d+))?(?:\.pdf)?\/?$/i;

export function parseArxivReference(input: string): ArxivReference | null {
  const match = arxivUrlPattern.exec(input.trim());
  if (!match) return null;

  const arxivId = match[1]?.toLowerCase();
  const versionText = match[2];
  if (!arxivId) return null;

  return {
    arxivId,
    explicitVersion: versionText ? Number.parseInt(versionText, 10) : null,
  };
}
