export interface WcCounts {
  lines: number;
  words: number;
  third: number;
  bytes: number;
}
export interface WcSelection {
  lines: boolean;
  words: boolean;
  chars: boolean;
}

/** Scan only requested fields and retain no input or array of codepoints. */
export function createWcCounter(selection: WcSelection): {
  update(chunk: Uint8Array): void;
  finish(): WcCounts;
} {
  let bytes = 0,
    lines = 0,
    words = 0,
    chars = 0;
  let inWord = false,
    invalidUtf8 = false;
  const decoder = selection.chars
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    : undefined;
  const countCharacters = (text: string) => {
    for (const _character of text) chars++;
  };
  return {
    update(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (selection.words) {
        for (let at = 0; at < chunk.length; at++) {
          const byte = chunk[at];
          if (selection.lines && byte === 10) lines++;
          if (byte === 10 || byte === 32 || byte === 9 || byte === 13) {
            if (inWord) words++;
            inWord = false;
          } else inWord = true;
        }
      } else if (selection.lines) {
        for (
          let at = chunk.indexOf(10);
          at !== -1;
          at = chunk.indexOf(10, at + 1)
        )
          lines++;
      }
      if (decoder && !invalidUtf8) {
        try {
          countCharacters(decoder.decode(chunk, { stream: true }));
        } catch {
          invalidUtf8 = true;
        }
      }
    },
    finish(): WcCounts {
      if (decoder && !invalidUtf8) {
        try {
          countCharacters(decoder.decode());
        } catch {
          invalidUtf8 = true;
        }
      }
      return {
        lines,
        words: words + Number(inWord),
        third: decoder && !invalidUtf8 ? chars : bytes,
        bytes,
      };
    },
  };
}
