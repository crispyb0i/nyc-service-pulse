// CLS uses the largest session window: <1s between shifts, at most 5s total.
export function layoutShiftScores(shifts) {
  let cls = 0, score = 0, start = -Infinity, previous = -Infinity, sum = 0;
  for (const shift of shifts.filter((item) => !item.recentInput).sort((a, b) => a.start - b.start)) {
    if (shift.start - previous >= 1000 || shift.start - start >= 5000) { score = 0; start = shift.start; }
    score += shift.value; sum += shift.value; previous = shift.start;
    cls = Math.max(cls, score);
  }
  return { cls, layoutShiftScoreSum: sum };
}
