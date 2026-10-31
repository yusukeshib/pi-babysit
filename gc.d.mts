export interface BabysitGcResult {
	candidates: string[];
	deleted: string[];
	bytes: number;
	skippedLive: string[];
}

export interface BabysitGcOptions {
	rootBase: string;
	currentRoot: string;
	olderThanMs: number;
	dryRun?: boolean;
	now?: number;
}

export declare const GC_LOCK_FILE: string;
export declare const GC_STAMP_FILE: string;
export declare const AUTOMATIC_GC_INTERVAL_MS: number;
export declare const ACTIVE_LEASE_PREFIX: string;
export declare function isConfirmedTerminalState(state: string): boolean;
export declare function processIsAlive(pid: number): boolean;
export declare function gcBabysitRoots(options: BabysitGcOptions): BabysitGcResult;
