import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { layoutShiftScores } from './layout-shifts.mjs';

const { values } = parseArgs({ options: { before: { type: 'string', default: 'before' }, after: { type: 'string', default: 'after-stable-layout' }, output: { type: 'string', default: 'comparison' } } });
for (const label of Object.values(values)) assert.match(label, /^[a-z0-9][a-z0-9-]{0,39}$/);
const median = (items) => { const sorted = [...items].sort((a,b)=>a-b); return sorted.length%2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2; };
const result = { before: values.before, after: values.after, method: 'Medians across three runs per profile. Page statistic is median of each run’s five-page median. CLS is recomputed from raw shifts using largest 5-second session windows with <1-second gaps, excluding recent input. Earlier reports mislabeled the all-shifts sum as cls; their original files remain preserved. No field INP, FPS, or service-level claim.', profiles: {} };
for (const label of [values.before, values.after]) {
  const report = JSON.parse(await readFile(`reports/portfolio/${label}/performance.json`, 'utf8'));
  assert.equal(report.status, 'passed');
  for (const profile of ['desktop','constrained-mobile']) {
    const runs = report.runs.filter((run) => run.profile === profile);
    result.profiles[profile] ??= {};
    result.profiles[profile][label] = {
      nextPageMedianMs: median(runs.map((run)=>run.summary.nextPageMedianMs)),
      nextPageRunRangeMs: [Math.min(...runs.map((run)=>run.summary.nextPageMedianMs)),Math.max(...runs.map((run)=>run.summary.nextPageMedianMs))],
      coldBrowserSettlementMs: median(runs.map((run)=>run.loads.find((load)=>load.temperature==='cold-browser').settledMs)),
      warmBrowserSettlementMs: median(runs.map((run)=>run.loads.find((load)=>load.temperature==='warm-browser').settledMs)),
      observedEventP95Ms: median(runs.map((run)=>run.summary.eventDurationP95Ms)),
      rafIntervalP95Ms: median(runs.map((run)=>run.summary.frameIntervalP95Ms)),
      cls: median(runs.map((run)=>layoutShiftScores(run.probe.shifts).cls)),
      longTasks: runs.map((run)=>run.summary.observedLongTasks),
      pageRequestPaths: [...new Set(runs.flatMap((run)=>run.interactions.filter((item)=>item.action==='next-page').flatMap((item)=>item.apiRequests)))],
    };
  }
}
await writeFile(`reports/portfolio/${values.output}.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result,null,2));
