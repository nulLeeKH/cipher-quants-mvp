// ============================================================================
// Admin challenge message format
// ============================================================================
// Plain UTF-8 string that the wallet signs. Server reconstructs the same
// string from the challenge token and verifies the ed25519 signature.
// ============================================================================

export interface ChallengeMessageParts {
  nonce: string;
  pool?: string;
  pubkey: string;
  issuedAt: string; // ISO
}

export function formatChallengeMessage(parts: ChallengeMessageParts): string {
  const lines = [
    "Cipher Quants — Admin sign-in",
    `Pubkey: ${parts.pubkey}`,
    parts.pool ? `Pool: ${parts.pool}` : "",
    `Nonce: ${parts.nonce}`,
    `Issued: ${parts.issuedAt}`,
    "",
    "Sign this message to authenticate with the admin console.",
    "No tokens will be transferred.",
  ].filter(Boolean);
  return lines.join("\n");
}
