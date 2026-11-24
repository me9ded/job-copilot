export type DiffOp<T> = { type: 'same' | 'add' | 'del'; value: T };

/** LCS-based diff. Inputs are capped so pathological documents stay fast. */
export function diff<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): DiffOp<T>[] {
  const A = a.slice(0, 1500);
  const B = b.slice(0, 1500);
  const n = A.length;
  const m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = eq(A[i]!, B[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(A[i]!, B[j]!)) {
      out.push({ type: 'same', value: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: 'del', value: A[i++]! });
    else out.push({ type: 'add', value: B[j++]! });
  }
  while (i < n) out.push({ type: 'del', value: A[i++]! });
  while (j < m) out.push({ type: 'add', value: B[j++]! });
  return out;
}

export const diffLines = (a: string, b: string) => diff(a.split('\n'), b.split('\n'));
export const diffWords = (a: string, b: string) => diff(a.split(/(\s+)/), b.split(/(\s+)/));
