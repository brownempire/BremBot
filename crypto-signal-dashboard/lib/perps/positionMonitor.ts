export async function monitorSubmittedPerpsExecution(input: {
  txid: string | null;
  positionPubkey: string | null;
}) {
  return {
    status: input.txid ? "submitted" : "unknown",
    txid: input.txid,
    positionPubkey: input.positionPubkey,
  } as const;
}
