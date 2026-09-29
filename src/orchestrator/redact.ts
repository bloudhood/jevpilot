const REDACTED = "[REDACTED]";
// Text the observer cuts short (values at 60 characters, names at 80, page text at a budget) can show only
// the start of a secret, so a run of this many leading characters is redacted as well.
const PARTIAL_PREFIX = 8;

type Piece = { char: string; start: number; end: number };

const hexByte = (text: string, at: number): number | undefined =>
  text[at] === "%" && /^[0-9A-Fa-f]{2}$/u.test(text.slice(at + 1, at + 3))
    ? parseInt(text.slice(at + 1, at + 3), 16)
    : undefined;
const utf8Length = (lead: number): number =>
  lead < 0x80
    ? 1
    : lead >> 5 === 0b110
      ? 2
      : lead >> 4 === 0b1110
        ? 3
        : lead >> 3 === 0b11110
          ? 4
          : 0;

// The text as a page or browser may have rewritten a secret in it: %XX escapes decoded, runs of whitespace
// collapsed to one space (as the observer does), each character with its span in the source text.
function pieces(text: string): Piece[] {
  const found: Piece[] = [];
  const push = (char: string, start: number, end: number): void => {
    const normalized = /^\s$/u.test(char) ? " " : char;
    const previous = found.at(-1);
    if (normalized === " " && previous?.char === " ") previous.end = end;
    else found.push({ char: normalized, start, end });
  };
  for (let index = 0; index < text.length;) {
    const lead = hexByte(text, index);
    if (lead !== undefined) {
      const length = utf8Length(lead);
      const bytes = [lead];
      for (let next = 1; next < length; next++) {
        const byte = hexByte(text, index + 3 * next);
        if (byte === undefined || (byte & 0xc0) !== 0x80) break;
        bytes.push(byte);
      }
      if (length > 0 && bytes.length === length) {
        try {
          const char = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
          push(char, index, index + 3 * length);
          index += 3 * length;
          continue;
        } catch {
          /* Not valid UTF-8: the percent sign stays literal. */
        }
      }
    }
    const char = String.fromCodePoint(text.codePointAt(index)!);
    push(char, index, index + char.length);
    index += char.length;
  }
  return found;
}

// A form-encoded query writes a space as "+".
const same = (piece: Piece, wanted: string): boolean =>
  piece.char === wanted || (wanted === " " && piece.char === "+");

// Redacts a secret and the forms a page or the browser echoes it in: percent-encoded (as in a URL that
// carries a submitted form), form-encoded, with whitespace collapsed, or cut off after its first characters.
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  let clean = text.replaceAll(secret, REDACTED);
  const wanted = Array.from(secret.replace(/\s+/gu, " ").trim());
  if (wanted.length === 0) return clean;
  const minimum = Math.min(PARTIAL_PREFIX, wanted.length);
  const source = pieces(clean);
  const spans: [number, number][] = [];
  for (let index = 0; index < source.length;) {
    let run = 0;
    while (
      run < wanted.length &&
      index + run < source.length &&
      same(source[index + run]!, wanted[run]!)
    )
      run++;
    if (run >= minimum) {
      spans.push([source[index]!.start, source[index + run - 1]!.end]);
      index += run;
    } else index++;
  }
  for (const [start, end] of spans.reverse())
    clean = `${clean.slice(0, start)}${REDACTED}${clean.slice(end)}`;
  return clean;
}
