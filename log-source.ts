import * as fs from "node:fs";
import * as path from "node:path";

export interface LogPage {
	start: number;
	end: number;
	text: string;
	lineTimestamps: (number | undefined)[];
}

/** Byte cursors, not an index: only the selected sliding window is retained. */
export class FileLogSource {
	readonly pageBytes: number;
	size = 0;
	metadataVersion = "";
	private identity = "";
	private modified = 0;
	constructor(readonly file: string, readonly isAgent = false, pageBytes = 64 * 1024) {
		this.pageBytes = Math.max(1, pageBytes);
	}
	/** A changed identity or shrinking file invalidates every cursor. */
	refresh(): boolean {
		try {
			const stat = fs.statSync(path.join(path.dirname(this.file), "output.timestamps.jsonl"));
			this.metadataVersion = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
		} catch { this.metadataVersion = ""; }
		try {
			const stat = fs.statSync(this.file);
			const identity = `${stat.dev}:${stat.ino}`;
			const reset = identity !== this.identity || stat.size < this.size ||
				(stat.size === this.size && stat.mtimeMs !== this.modified);
			this.identity = identity;
			this.modified = stat.mtimeMs;
			this.size = stat.size;
			return reset;
		} catch {
			const reset = this.identity !== "";
			this.identity = "";
			this.size = 0;
			return reset;
		}
	}
	private bytes(fd: number, start: number, end: number): Buffer {
		const data = Buffer.alloc(Math.max(0, end - start));
		let read = 0;
		while (read < data.length) {
			const n = fs.readSync(fd, data, read, data.length - read, start + read);
			if (!n) break;
			read += n;
		}
		return data.subarray(0, read);
	}
	/** Find record boundaries in fixed-size reads. Keep assistant snapshots and
	 * subsequent tool results together, but never require a whole agent task:
	 * each new assistant message is another safe page boundary. Limits are soft
	 * for a single response/result group or oversized individual record. */
	private boundary(fd: number, position: number, direction: -1 | 1): number {
		const chunk = 8192;
		let cursor = Math.max(0, Math.min(position, this.size));
		if (!this.isAgent) {
			while (direction < 0 ? cursor > 0 : cursor < this.size) {
				const start = direction < 0 ? Math.max(0, cursor - chunk) : cursor;
				const end = direction < 0 ? cursor : Math.min(this.size, cursor + chunk);
				const data = this.bytes(fd, start, Math.min(this.size, end + 1));
				for (let i = direction < 0 ? end - start - 1 : 0;
					direction < 0 ? i >= 0 : i < end - start; i += direction) {
					if (data[i] !== 10 && data[i] !== 13) continue;
					const boundary = start + i + (data[i] === 13 && data[i + 1] === 10 ? 2 : 1);
					if (direction < 0 ? boundary <= position : boundary >= position) return boundary;
				}
				cursor = direction < 0 ? start : end;
			}
			return direction < 0 ? 0 : this.size;
		}
		// Scan records in non-overlapping chunks. Carry only the record crossing
		// the chunk edge, so normal pages do not reread 8 KiB for every event.
		cursor = this.recordBoundary(fd, position, direction < 0 ? 1 : -1);
		let parts: Buffer[] = [];
		let recordStart = cursor;
		const isStart = (start: number, segments: Buffer[]) => {
			if (!(direction < 0 ? start <= position : start >= position)) return false;
			try {
				const event = JSON.parse(Buffer.concat(segments).toString("utf8"));
				return event?.type === "agent_start" ||
					(event?.type === "message_start" && event.message?.role === "assistant");
			} catch { return false; }
		};
		while (direction < 0 ? cursor > 0 : cursor < this.size) {
			const start = direction < 0 ? Math.max(0, cursor - chunk) : cursor;
			const end = direction < 0 ? cursor : Math.min(this.size, cursor + chunk);
			const data = this.bytes(fd, start, Math.min(this.size, end + 1));
			let edge = direction < 0 ? end - start : 0;
			for (let i = direction < 0 ? end - start - 1 : 0;
				direction < 0 ? i >= 0 : i < end - start; i += direction) {
				if (data[i] !== 10 && data[i] !== 13) continue;
				if (data[i] === 13 && data[i + 1] === 10) continue;
				if (direction < 0) {
					const segments = [data.subarray(i + 1, edge), ...parts];
					if (isStart(start + i + 1, segments)) return start + i + 1;
					parts = []; edge = i + 1;
				} else {
					parts.push(data.subarray(edge, i + 1));
					if (isStart(recordStart, parts)) return recordStart;
					parts = []; edge = i + 1; recordStart = start + edge;
				}
			}
			if (direction < 0) parts.unshift(data.subarray(0, edge));
			else parts.push(data.subarray(edge, end - start));
			cursor = direction < 0 ? start : end;
		}
		if (isStart(direction < 0 ? 0 : recordStart, parts)) return direction < 0 ? 0 : recordStart;
		return direction < 0 ? 0 : this.size;
	}
	private recordBoundary(fd: number, position: number, direction: -1 | 1): number {
		// Same byte scanner, without interpreting agent events.
		const processSource = new FileLogSource(this.file, false, this.pageBytes);
		processSource.size = this.size;
		return processSource.boundary(fd, position, direction);
	}
	private empty(): LogPage { return { start: 0, end: 0, text: "", lineTimestamps: [] }; }
	private page(fd: number, start: number, end: number): LogPage {
		const data = this.bytes(fd, start, end);
		return { start, end: start + data.length, text: data.toString("utf8"), lineTimestamps: this.timestamps(data, start) };
	}
	before(end = this.size): LogPage {
		if (!this.size) return this.empty();
		let fd: number | undefined;
		try {
			fd = fs.openSync(this.file, "r");
			return this.page(fd, this.boundary(fd, Math.max(0, end - this.pageBytes), -1), end);
		} catch { this.dispose(); return this.empty(); }
		finally { if (fd !== undefined) fs.closeSync(fd); }
	}
	after(start: number): LogPage {
		if (!this.size) return this.empty();
		let fd: number | undefined;
		try {
			fd = fs.openSync(this.file, "r");
			return this.page(fd, start, this.boundary(fd, Math.min(this.size, start + this.pageBytes), 1));
		} catch { this.dispose(); return this.empty(); }
		finally { if (fd !== undefined) fs.closeSync(fd); }
	}
	/** Sorted sidecar byte ranges permit a binary seek without a persistent index.
	 * Capture metadata is optional; malformed records have no trusted timestamp. */
	private timestamps(data: Buffer, offset: number): (number | undefined)[] {
		const times: (number | undefined)[] = [];
		const positions = [offset];
		for (let i = 0; i < data.length; i++) {
			if (data[i] !== 10 && data[i] !== 13) continue;
			if (data[i] === 13 && data[i + 1] === 10) i++;
			positions.push(offset + i + 1);
		}
		let fd: number | undefined;
		try {
			fd = fs.openSync(path.join(path.dirname(this.file), "output.timestamps.jsonl"), "r");
			const size = fs.fstatSync(fd).size;
			const record = (at: number) => {
				let start = at;
				if (at > 0) {
					while (start > 0) {
						const begin = Math.max(0, start - 1024);
						const b = this.bytes(fd!, begin, start);
						const newline = b.lastIndexOf(10);
						if (newline >= 0) { start = begin + newline + 1; break; }
						start = begin;
					}
				}
				let end = start;
				const chunks: Buffer[] = [];
				while (end < size) {
					const b = this.bytes(fd!, end, Math.min(size, end + 1024));
					if (!b.length) break;
					const newline = b.indexOf(10);
					const n = newline < 0 ? b.length : newline + 1;
					chunks.push(b.subarray(0, n)); end += n;
					if (newline >= 0) break;
				}
				let value: number[] | undefined;
				try {
					const r = JSON.parse(Buffer.concat(chunks).toString());
					if (Array.isArray(r) && r.length === 3 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[1] > 0 && Number.isSafeInteger(r[0] + r[1]) && r[2] >= 0 && r[2] <= 8640000000000000) value = r;
				} catch { /* Optional malformed metadata. */ }
				return { start, end, value };
			};
			let low = 0, high = size;
			while (low < high) {
				const r = record(Math.floor((low + high) / 2));
				// An invalid seek pivot gives no ordering evidence. Do not fall back
				// to a full sidecar scan; metadata is optional, raw history is not.
				if (!r.value) return positions.map(() => undefined);
				if (r.value[0] + r.value[1] <= offset) low = Math.max(low + 1, r.end);
				else high = r.start;
			}
			let position = 0, cursor = low;
			let pending: Buffer[] = [];
			let previousEnd = 0;
			while (cursor < size && position < positions.length) {
				let chunk = this.bytes(fd, cursor, Math.min(size, cursor + 8192));
				if (!chunk.length) break;
				cursor += chunk.length;
				if (cursor === size && chunk.at(-1) !== 10) chunk = Buffer.concat([chunk, Buffer.from("\n")]);
				let edge = 0;
				for (let i = 0; i < chunk.length && position < positions.length; i++) {
					if (chunk[i] !== 10) continue;
					pending.push(chunk.subarray(edge, i)); edge = i + 1;
					const text = Buffer.concat(pending).toString(); pending = [];
					let value: number[];
					try {
						value = JSON.parse(text);
						if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isSafeInteger) ||
							value[0] < previousEnd || value[1] <= 0 || !Number.isSafeInteger(value[0] + value[1]) ||
							value[2] < 0 || value[2] > 8640000000000000) continue;
					} catch { continue; }
					const [start, length, time] = value;
					previousEnd = start + length;
					while (position < positions.length && positions[position] < start) times[position++] = undefined;
					while (position < positions.length && positions[position] < start + length) {
						times[position] = positions[position] < offset + data.length ? time : undefined;
						position++;
					}
				}
				pending.push(chunk.subarray(edge));
			}
		} catch { /* Missing sidecars are normal for old logs. */ }
		finally { if (fd !== undefined) fs.closeSync(fd); }
		return positions.map((_, i) => times[i]);
	}
	retime(page: LogPage): LogPage {
		return { ...page, lineTimestamps: this.timestamps(Buffer.from(page.text), page.start) };
	}
	dispose() { this.identity = ""; this.size = 0; this.metadataVersion = ""; }
}
