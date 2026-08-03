export function removeOrganizationAliasCandidate<T>(candidates: readonly T[], index: number): T[] {
  return candidates.filter((_, candidateIndex) => candidateIndex !== index);
}

export function canConfirmOrganizationAliasDraft(candidates: readonly unknown[]): boolean {
  return candidates.length > 0;
}
