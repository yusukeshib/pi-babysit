import fs from "node:fs";
import { createInterface } from "node:readline";

const [file, source, maxLinesRaw] = process.argv.slice(2);
const maxLines = Math.min(Math.max(1, Number.parseInt(maxLinesRaw ?? "30", 10) || 30), 200);
const MAX_LINE_BYTES = 4_000;

let pattern;
try {
	pattern = new RegExp(source);
} catch (error) {
	console.error(`Invalid pattern: ${String(error)}`);
	process.exit(2);
}

function clipLine(line) {
	const bytes = Buffer.from(line, "utf8");
	if (bytes.length <= MAX_LINE_BYTES) return line;
	const half = Math.floor(MAX_LINE_BYTES / 2);
	const head = bytes.subarray(0, half).toString("utf8").replace(/\uFFFD+$/, "");
	const tail = bytes.subarray(bytes.length - half).toString("utf8").replace(/^\uFFFD+/, "");
	return `${head}… [line clipped] …${tail}`;
}

const matches = [];
let lineNumber = 0;
try {
	const input = fs.createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	for await (const line of lines) {
		lineNumber++;
		pattern.lastIndex = 0;
		if (!pattern.test(line)) continue;
		matches.push(`${lineNumber}:${clipLine(line)}`);
		if (matches.length > maxLines) matches.shift();
	}
} catch (error) {
	console.error(`Could not search log: ${String(error)}`);
	process.exit(1);
}

process.stdout.write(matches.join("\n"));
