import { parentPort } from "worker_threads";
import { promises as fsp } from "fs";
import * as path from "path";
import { DiffResult } from "./types";

interface DiffParamsIn {
  currentFilePath: string;
  compareWorkspaceFilePath: string;
  compareRelativeFilePath: string;
  compareWorkspaceName: string;
  ignoreWhiteSpace: boolean;
  baseContent?: string; // optional preloaded content of currentFilePath to avoid repeated reads
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function compareFile(params: DiffParamsIn): Promise<DiffResult> {
  const {
    currentFilePath,
    compareWorkspaceFilePath,
    compareRelativeFilePath,
    compareWorkspaceName,
    ignoreWhiteSpace,
    baseContent,
  } = params;

  const resolvedCompareFilePath = path.join(
    compareWorkspaceFilePath,
    compareRelativeFilePath
  );

  const [baseExists, compareExists] = await Promise.all([
    // If base content provided, treat base as existing
    baseContent !== undefined ? Promise.resolve(true) : fileExists(currentFilePath),
    fileExists(resolvedCompareFilePath),
  ]);

  if (!baseExists) {
    return {
      projectName: compareWorkspaceName,
      diffLineCount: 0,
      diffDetail: { added: 0, removed: 0 },
      compareFilePath: resolvedCompareFilePath,
      fileExists: compareExists,
      compareWorkspaceFilePath,
    };
  }

  if (!compareExists) {
    return {
      projectName: compareWorkspaceName,
      diffLineCount: 0,
      diffDetail: { added: 0, removed: 0 },
      compareFilePath: resolvedCompareFilePath,
      fileExists: false,
      compareWorkspaceFilePath,
    };
  }

  const [baseText, compareText] = await Promise.all([
    baseContent !== undefined ? Promise.resolve(baseContent) : fsp.readFile(currentFilePath, "utf8"),
    fsp.readFile(resolvedCompareFilePath, "utf8"),
  ]);

  // Fast path: exact equality
  if (baseText === compareText) {
    return {
      projectName: compareWorkspaceName,
      diffLineCount: 0,
      diffDetail: { added: 0, removed: 0 },
      compareFilePath: resolvedCompareFilePath,
      fileExists: true,
      compareWorkspaceFilePath,
    };
  }

  // Compute exact diff counts using an optimized Myers edit distance on tokenized lines
  const { added, removed } = computeDiffCounts(baseText, compareText, !!ignoreWhiteSpace);

  return {
    projectName: compareWorkspaceName,
    diffLineCount: added + removed,
    diffDetail: { added, removed },
    compareFilePath: resolvedCompareFilePath,
    fileExists: true,
    compareWorkspaceFilePath,
  };
}

if (!parentPort) {
  throw new Error("diffWorker must be run as a worker thread");
}

parentPort.on("message", async (msg: any) => {
  const { id, payload } = msg || {};
  try {
    const result = await compareFile(payload as DiffParamsIn);
    parentPort!.postMessage({ id, result });
  } catch (error: any) {
    parentPort!.postMessage({ id, error: { message: String(error?.message || error) } });
  }
});

// ---- Internal exact diff (counts-only) utilities ----

function normalizeEol(text: string): string {
  // Normalize CRLF/CR to LF for consistent line splitting
  return text.replace(/\r\n?|\u2028|\u2029/g, "\n");
}

function maybeNormalizeWhitespace(line: string, ignoreWhiteSpace: boolean): string {
  if (!ignoreWhiteSpace) return line;
  // Collapse all whitespace to a single space and trim
  // This approximates a whitespace-insensitive comparison for counting purposes
  return line.replace(/\s+/g, " ").trim();
}

function splitToLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

function trimCommonPrefixSuffix(
  a: string[],
  b: string[]
): { aStart: number; aEnd: number; bStart: number; bEnd: number } {
  let aStart = 0;
  let bStart = 0;
  const aLen = a.length;
  const bLen = b.length;
  // Prefix
  while (aStart < aLen && bStart < bLen && a[aStart] === b[bStart]) {
    aStart++;
    bStart++;
  }
  // Suffix
  let aEnd = aLen - 1;
  let bEnd = bLen - 1;
  while (aEnd >= aStart && bEnd >= bStart && a[aEnd] === b[bEnd]) {
    aEnd--;
    bEnd--;
  }
  return { aStart, aEnd, bStart, bEnd };
}

function tokenizePair(aLines: string[], bLines: string[]): { aTok: Int32Array; bTok: Int32Array } {
  // Use a shared dictionary so identical line strings get identical IDs across both arrays
  const dict = new Map<string, number>();
  let nextId = 1;
  const aTok = new Int32Array(aLines.length);
  const bTok = new Int32Array(bLines.length);
  for (let i = 0; i < aLines.length; i++) {
    const s = aLines[i];
    let id = dict.get(s);
    if (id === undefined) {
      id = nextId++;
      dict.set(s, id);
    }
    aTok[i] = id;
  }
  for (let i = 0; i < bLines.length; i++) {
    const s = bLines[i];
    let id = dict.get(s);
    if (id === undefined) {
      id = nextId++;
      dict.set(s, id);
    }
    bTok[i] = id;
  }
  return { aTok, bTok };
}

function myersEditDistance(a: Int32Array, b: Int32Array): number {
  // Compute minimal edit distance (insertions+deletions) using Myers O(ND)
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const max = n + m;
  const v = new Int32Array(2 * max + 1);
  const offset = max;
  v[offset + 1] = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return d;
      }
    }
  }
  return max;
}

function computeDiffCounts(baseText: string, compareText: string, ignoreWhiteSpace: boolean): { added: number; removed: number } {
  // Normalize line endings
  const aRaw = splitToLines(normalizeEol(baseText));
  const bRaw = splitToLines(normalizeEol(compareText));

  // Apply optional whitespace normalization
  const aNorm = aRaw.map((s) => maybeNormalizeWhitespace(s, ignoreWhiteSpace));
  const bNorm = bRaw.map((s) => maybeNormalizeWhitespace(s, ignoreWhiteSpace));

  // Trim common prefixes/suffixes
  const { aStart, aEnd, bStart, bEnd } = trimCommonPrefixSuffix(aNorm, bNorm);
  const aSlice = aNorm.slice(aStart, aEnd + 1);
  const bSlice = bNorm.slice(bStart, bEnd + 1);

  const n = aSlice.length;
  const m = bSlice.length;
  if (n === 0 && m === 0) {
    return { added: 0, removed: 0 };
  }

  // Tokenize to integers using a shared dictionary
  const { aTok, bTok } = tokenizePair(aSlice, bSlice);

  // Compute minimal edit distance D, derive LCS and counts
  const d = myersEditDistance(aTok, bTok);
  const lcs = (n + m - d) >> 1; // integer division
  const removed = n - lcs;
  const added = m - lcs;
  return { added, removed };
}
