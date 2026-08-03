import { describe, expect, it } from "vitest";

import { canConfirmOrganizationAliasDraft, removeOrganizationAliasCandidate }
  from "../src/web/organization-alias-draft.js";

describe("Paper Organization Alias draft", () => {
  it("removes only the Alias candidate selected by the user", () => {
    const candidates = [
      { name: "GaP", kind: "model-name" as const, preferred: true },
      { name: "Graph-as-Policy", kind: "model-name" as const, preferred: false },
    ];

    expect(removeOrganizationAliasCandidate(candidates, 1)).toEqual([candidates[0]]);
  });

  it("requires at least one remaining Alias before confirmation", () => {
    expect(canConfirmOrganizationAliasDraft([{ name: "GaP" }])).toBe(true);
    expect(canConfirmOrganizationAliasDraft([])).toBe(false);
  });
});
