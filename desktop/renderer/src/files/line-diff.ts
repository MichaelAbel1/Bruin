export type DiffLine = {
  type: 'added' | 'deleted' | 'unchanged';
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffResult = {
  diff: DiffLine[];
  additions: number;
  deletions: number;
};

/** Bounded Myers O((m+n)*D) line diff for the middle slice; returns null when edit distance > maxD. */
function myersDiff(
  midOld: string[],
  midNew: string[],
  prefix: number,
  maxD: number,
): DiffLine[] | null {
  const m = midOld.length;
  const n = midNew.length;
  const limit = Math.min(maxD, m + n);
  const offset = limit;
  const size = 2 * limit + 1;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < m && y < n && midOld[x] === midNew[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= m && y >= n) {
        const rev: DiffLine[] = [];
        let cx = m;
        let cy = n;
        for (let step = d; step > 0; step--) {
          const prev = trace[step];
          const ck = cx - cy;
          let prevK: number;
          if (ck === -step || (ck !== step && prev[offset + ck - 1] < prev[offset + ck + 1])) {
            prevK = ck + 1;
          } else {
            prevK = ck - 1;
          }
          const prevX = prev[offset + prevK];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            rev.push({
              type: 'unchanged',
              text: midOld[cx - 1],
              oldLine: prefix + cx,
              newLine: prefix + cy,
            });
            cx--;
            cy--;
          }
          if (cx === prevX) {
            rev.push({ type: 'added', text: midNew[cy - 1], newLine: prefix + cy });
            cy--;
          } else {
            rev.push({ type: 'deleted', text: midOld[cx - 1], oldLine: prefix + cx });
            cx--;
          }
        }
        while (cx > 0 && cy > 0) {
          rev.push({
            type: 'unchanged',
            text: midOld[cx - 1],
            oldLine: prefix + cx,
            newLine: prefix + cy,
          });
          cx--;
          cy--;
        }
        const ordered: DiffLine[] = [];
        for (let idx = rev.length - 1; idx >= 0; idx--) ordered.push(rev[idx]);
        return ordered;
      }
    }
  }
  return null;
}

export function computeLineDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);

  const diff: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    diff.push({ type: 'unchanged', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  const m = midOld.length;
  const n = midNew.length;

  if (m === 0 || n === 0) {
    for (let i = 0; i < m; i++) {
      diff.push({ type: 'deleted', text: midOld[i], oldLine: prefix + i + 1 });
    }
    for (let j = 0; j < n; j++) {
      diff.push({ type: 'added', text: midNew[j], newLine: prefix + j + 1 });
    }
  } else {
    const midDiff = myersDiff(midOld, midNew, prefix, 1500);
    if (midDiff) {
      for (let k = 0; k < midDiff.length; k++) diff.push(midDiff[k]);
    } else {
      for (let i = 0; i < m; i++) {
        diff.push({ type: 'deleted', text: midOld[i], oldLine: prefix + i + 1 });
      }
      for (let j = 0; j < n; j++) {
        diff.push({ type: 'added', text: midNew[j], newLine: prefix + j + 1 });
      }
    }
  }

  const oldSuffixStart = oldLines.length - suffix;
  const newSuffixStart = newLines.length - suffix;
  for (let k = 0; k < suffix; k++) {
    diff.push({
      type: 'unchanged',
      text: oldLines[oldSuffixStart + k],
      oldLine: oldSuffixStart + k + 1,
      newLine: newSuffixStart + k + 1,
    });
  }

  let additions = 0;
  let deletions = 0;
  for (const line of diff) {
    if (line.type === 'added') additions++;
    else if (line.type === 'deleted') deletions++;
  }

  return { diff, additions, deletions };
}
