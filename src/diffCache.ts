import * as os from "os";
import { DiffResult } from "./types";

export interface DiffCacheKeyParts {
	basePath: string;
	baseMtimeMs: number; // -1 when missing/unreadable
	comparePath: string;
	compareMtimeMs: number; // -1 when missing
	ignoreWhitespace: boolean;
}

interface CacheEntry {
	key: string;
	parts: DiffCacheKeyParts;
	result: DiffResult;
}

function isCaseInsensitiveFs(): boolean {
	return os.platform() === "win32" || os.platform() === "darwin";
}

function normPath(p: string): string {
	return isCaseInsensitiveFs() ? p.toLowerCase() : p;
}

export function makeCacheKey(parts: DiffCacheKeyParts): string {
	const b = normPath(parts.basePath);
	const c = normPath(parts.comparePath);
	const iw = parts.ignoreWhitespace ? 1 : 0;
	return `v1|iw:${iw}|b:${b}|bm:${parts.baseMtimeMs}|c:${c}|cm:${parts.compareMtimeMs}`;
}

function makeReversedKey(parts: DiffCacheKeyParts): string {
	return makeCacheKey({
		basePath: parts.comparePath,
		baseMtimeMs: parts.compareMtimeMs,
		comparePath: parts.basePath,
		compareMtimeMs: parts.baseMtimeMs,
		ignoreWhitespace: parts.ignoreWhitespace,
	});
}

export class DiffCache {
	private map = new Map<string, CacheEntry>();

	constructor(private maxEntries: number = 1000) {}

	get(parts: DiffCacheKeyParts): DiffResult | null {
		const key = makeCacheKey(parts);
		let entry = this.map.get(key);
		if (entry) {
			// LRU: move to end
			this.map.delete(key);
			this.map.set(key, entry);
			// Return a shallow copy to avoid accidental mutation
			return { ...entry.result };
		}

		// Try reversed direction and invert counts if found
		const rkey = makeReversedKey(parts);
		entry = this.map.get(rkey);
		if (entry) {
			this.map.delete(rkey);
			this.map.set(rkey, entry);
			const r = entry.result;
			return {
				projectName: r.projectName,
				diffLineCount: r.diffLineCount,
				diffDetail: { added: r.diffDetail.removed, removed: r.diffDetail.added },
				compareFilePath: parts.comparePath,
				fileExists: r.fileExists,
				compareWorkspaceFilePath: r.compareWorkspaceFilePath,
			};
		}
		return null;
	}

	set(parts: DiffCacheKeyParts, result: DiffResult): void {
		const key = makeCacheKey(parts);
		const entry: CacheEntry = { key, parts, result: { ...result } };
		this.map.set(key, entry);
		this.evictIfNeeded();
	}

	private evictIfNeeded() {
		while (this.map.size > this.maxEntries) {
			const firstKey = this.map.keys().next().value as string | undefined;
			if (!firstKey) break;
			this.map.delete(firstKey);
		}
	}
}

