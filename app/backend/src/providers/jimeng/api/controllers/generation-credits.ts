import { getCredit, receiveCredit } from "./core.ts";

export async function checkGenerationCredits(token: string) {
  const { totalCredit } = await getCredit(token);
  if (totalCredit <= 0) await receiveCredit(token);
}
