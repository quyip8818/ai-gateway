import { getCredit, receiveCredit } from "./core.ts";


export type ObserveGenerationBalance = (balance: number, grantedCredits: number) => void;

export async function checkGenerationCredits(token: string, observe?: ObserveGenerationBalance) {
  const { totalCredit } = await getCredit(token);
  const balance = totalCredit <= 0 ? await receiveCredit(token) : totalCredit;
  observe?.(balance, balance - totalCredit);
}
