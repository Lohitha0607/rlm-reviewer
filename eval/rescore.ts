// Re-score saved eval results with the current scoring (no model calls).
//   bun eval/rescore.ts eval/results/<file>.json
import { score } from "./run_eval";

const path = process.argv[2]!;
const data = await Bun.file(path).json();
for (const row of data.results) {
  if (row.error) continue;
  const meta = await Bun.file(`/tmp/rlm-eval-prs/${row.pr}.json`).json();
  const s = score(row.review, meta.bugs);
  console.log(
    `${row.pr.padEnd(6)} ${row.mode.padEnd(8)} detected ${s.detected.length}/${row.bugs} · located ${s.found.length}/${row.bugs} · ` +
      `false alarms ${s.falseAlarms} · input tokens ${row.inputTokens.toLocaleString()} · calls ${row.modelCalls}`,
  );
}
