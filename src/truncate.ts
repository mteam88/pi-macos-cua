export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DETAILS_PREVIEW_MAX_LINES = 200;
export const DETAILS_PREVIEW_MAX_BYTES = 8 * 1024;

export interface TextTruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TextTruncationResult {
  text: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
}

export function truncateText(input: string, options: TextTruncationOptions = {}): TextTruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(input, "utf8");
  const totalLines = countLines(input);

  let output = input;
  let lineTruncated = false;
  if (totalLines > maxLines) {
    output = input.split("\n").slice(0, maxLines).join("\n");
    lineTruncated = true;
  }

  let byteTruncated = false;
  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = takeUtf8Prefix(output, maxBytes);
    byteTruncated = true;
  }

  const outputBytes = Buffer.byteLength(output, "utf8");
  const outputLines = countLines(output);
  const truncated = lineTruncated || byteTruncated;

  if (!truncated) {
    return {
      text: output,
      truncated,
      totalLines,
      outputLines,
      totalBytes,
      outputBytes,
      maxLines,
      maxBytes,
    };
  }

  const suffix = `\n\n[Truncated: showing ${outputLines} of ${totalLines} lines, ${formatBytes(outputBytes)} of ${formatBytes(totalBytes)}. Limits: ${maxLines} lines / ${formatBytes(maxBytes)}.]`;

  return {
    text: `${output}${suffix}`,
    truncated,
    totalLines,
    outputLines,
    totalBytes,
    outputBytes,
    maxLines,
    maxBytes,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)}KB`;
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)}MB`;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let output = "";
  let usedBytes = 0;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > maxBytes) break;
    output += char;
    usedBytes += charBytes;
  }

  return output;
}
