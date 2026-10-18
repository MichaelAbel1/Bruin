type DiffLine = {
  type: 'added' | 'deleted' | 'unchanged';
  text: string;
  oldLine?: number;
  newLine?: number;
};

type DiffResult = {
  diff: DiffLine[];
  additions: number;
  deletions: number;
};

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

  if (m * n > 1_500_000) {
    for (let i = 0; i < m; i++) {
      diff.push({ type: 'deleted', text: midOld[i], oldLine: prefix + i + 1 });
    }
    for (let j = 0; j < n; j++) {
      diff.push({ type: 'added', text: midNew[j], newLine: prefix + j + 1 });
    }
  } else {
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (midOld[i - 1] === midNew[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    let i = m;
    let j = n;
    const midDiff: DiffLine[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && midOld[i - 1] === midNew[j - 1]) {
        midDiff.push({
          type: 'unchanged',
          text: midOld[i - 1],
          oldLine: prefix + i,
          newLine: prefix + j,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        midDiff.push({ type: 'added', text: midNew[j - 1], newLine: prefix + j });
        j--;
      } else {
        midDiff.push({ type: 'deleted', text: midOld[i - 1], oldLine: prefix + i });
        i--;
      }
    }
    midDiff.reverse();
    diff.push(...midDiff);
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
