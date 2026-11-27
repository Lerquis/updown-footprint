import { ChainId, OrderBuilder } from "@predictdotfun/sdk";
import { formatEther, JsonRpcProvider, Wallet } from "ethers";
import { config } from "../config.js";

/**
 * `npm run predict:approvals -w @updown/server` — aprobaciones on-chain que necesita la cuenta de Predict para comprar y vender en
 * los markets up/down (estandar: ni negRisk ni yieldBearing). Sin argumentos SOLO las comprueba (lectura). Con `--send` envia las
 * que falten: cada una es una transaccion en BNB Chain que paga gas en BNB desde la wallet firmante. Las ejecuta el usuario.
 * Usa PREDICT_PRIVATE_KEY y PREDICT_ACCOUNT de .env.local.
 */
const send = process.argv.includes("--send");
const { privateKey, account } = config.predict.live;
if (!privateKey.trim()) {
  console.error("Falta PREDICT_PRIVATE_KEY en apps/server/.env.local");
  process.exit(1);
}
const k = privateKey.trim();
const wallet = new Wallet(k.startsWith("0x") ? k : `0x${k}`);
const builder = account.trim() ? await OrderBuilder.make(ChainId.BnbMainnet, wallet, { predictAccount: account.trim() }) : await OrderBuilder.make(ChainId.BnbMainnet, wallet);
console.log(`Firmante: ${wallet.address}${account.trim() ? ` · cuenta de Predict ${account.trim()}` : " (EOA)"}`);

const steps = builder.getApprovalSteps({ operation: "TRADE", isNegRisk: false, isYieldBearing: false });
const checks = await builder.checkApprovals(steps);
for (const { step, satisfied } of checks) console.log(`  ${satisfied ? "ok      " : "FALTA   "} ${step.label}`);
const missing = checks.filter((c) => !c.satisfied).map((c) => c.step);
if (!missing.length) {
  console.log("Todas las aprobaciones para operar estan hechas.");
  process.exit(0);
}
if (!send) {
  console.log(`\nFaltan ${missing.length}. Para enviarlas (una transaccion cada una, con gas en BNB): npm run predict:approvals -w @updown/server -- --send`);
  process.exit(0);
}
// el gas lo paga la wallet que FIRMA (con una cuenta de Predict, la de Privy), no la cuenta: sin BNB ni se intenta
const gasWei = await new JsonRpcProvider("https://bsc-dataseed.bnbchain.org").getBalance(wallet.address);
if (gasWei < 10n ** 14n) {
  console.log(`\nLa wallet que firma (${wallet.address}) tiene ${formatEther(gasWei)} BNB. Envia unos 0,0002 BNB por BNB Smart Chain (BEP20)`);
  console.log("a ESA direccion (no a la cuenta de Predict) y vuelve a ejecutar. No se ha enviado nada.");
  process.exit(1);
}
const report = await builder.runApprovals(missing, { onProgress: ({ step, status }) => console.log(`  ${step.label}: ${status}`) });
for (const r of report.steps)
  if (r.status === "failed" && r.transaction && !r.transaction.success) console.log(`  causa (${r.step.label}): ${r.transaction.cause?.message ?? "desconocida"}`);
console.log(report.success ? "Aprobaciones enviadas." : "Alguna aprobacion fallo (causa arriba).");
process.exit(report.success ? 0 : 1);
