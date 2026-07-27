/**
 * The spelling dictionary: how this speaker's proper nouns are written.
 *
 * Transcription mishears names in ways nothing derived from the audio can fix.
 * On one real recording 「X」 came back as 「叉」 every time, and the aligner
 * could not correct it — the speaker had recorded the same sentence four times,
 * so every context around 「叉」 appeared more than once and the honest answer
 * was "cannot tell". A dictionary has no such problem: within one speaker's
 * work 「叉」 *is* 「X」, and saying so once is cheaper and more reliable than
 * inferring it from every sentence it appears in.
 *
 * The two halves are deliberately different tools:
 *
 * ```text
 * 词典    always this spelling, everywhere        no evidence needed, and none is used
 * 文稿    this spelling, where the context fits   evidence per occurrence, reports what it cannot tell
 * ```
 *
 * The dictionary lives with the skill, not with the product and not with a
 * project — it is the operator's accumulated knowledge of their own vocabulary,
 * and it should follow them from one video to the next. Nothing here knows that;
 * the caller supplies the file.
 */

export interface DictionaryEntry {
  from: string;
  to: string;
}

export interface ParsedDictionary {
  entries: DictionaryEntry[];
  /** Lines that are not a rule and not a comment, with their line numbers. */
  ignored: Array<{ line: number; text: string }>;
}

/** The cells of a Markdown table row, or null when the line is not one. */
function tableCells(raw: string): string[] | null {
  const line = raw.trim();
  if (!line.startsWith("|")) return null;
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isSeparatorRow(raw: string): boolean {
  const cells = tableCells(raw);
  return cells !== null && cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * A two-column Markdown table row, or null.
 *
 * The dictionary this product already maintains is written as
 * `| 正确写法 | 常见误识别 |` — one row per correct spelling, with every
 * mishearing of it on the right. That is a better shape than one rule per line
 * (a name is misheard five ways, and they belong together), and it is the shape
 * a person is already keeping up to date. Reading it directly is cheaper than
 * asking anyone to maintain a second copy in a different format.
 *
 * The header row and the `| --- |` separator produce nothing, because neither
 * half survives as a rule.
 */
function tableRow(raw: string): [string, string] | null {
  const cells = tableCells(raw);
  if (!cells || cells.length !== 2) return null;
  if (isSeparatorRow(raw)) return null;
  return [cells[0] ?? "", cells[1] ?? ""];
}

function unquote(value: string): string {
  return value.replace(/^[`「"']|[`」"']$/g, "").trim();
}

/**
 * Read a dictionary file.
 *
 * Two shapes, because the file is written and reviewed by a person: a
 * `| 正确写法 | 常见误识别 |` table, and `- heard -> written` list items.
 * Everything else is prose and is ignored without comment.
 *
 * That restriction is the whole design. The first version treated every line as
 * a candidate rule, so that a bare list of rules would work — and then reading
 * this project's own dictionary, which is a document explaining itself, it
 * reported thirty lines of prose as unreadable *and* parsed three sentences
 * into rules, because a sentence containing a tab or an `=` looks exactly like
 * `from = to`. A file that is meant to be read by a person has to say which
 * lines are the data.
 *
 * A row or list item that cannot be read is still reported: a typo in a rule is
 * otherwise indistinguishable from a name that never came up.
 */
export function parseDictionary(source: string): ParsedDictionary {
  const entries: DictionaryEntry[] = [];
  const ignored: ParsedDictionary["ignored"] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string): boolean => {
    if (!from || !to || from === to) return false;
    // First rule wins, so a project's own additions can be listed above the
    // general ones without the later duplicate silently overriding them.
    if (seen.has(from)) return true;
    seen.add(from);
    entries.push({ from, to });
    return true;
  };

  const lines = source.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const row = tableRow(raw);
    if (row) {
      // A table's header is the row directly above the `| --- |` separator.
      // Without this the header itself becomes a rule renaming one column title
      // to the other, which then matches nothing and looks like a silent bug.
      if (isSeparatorRow(lines[index + 1] ?? "")) return;
      const [to, heard] = row;
      let wrote = false;
      for (const from of heard.split(/\s*\/\s*/)) {
        // A parenthetical is a note to the reader, not part of the spelling.
        if (add(unquote(from.replace(/[（(][^)）]*[)）]/g, "")), unquote(to))) wrote = true;
      }
      if (!wrote) ignored.push({ line: index + 1, text: raw.trim() });
      return;
    }
  });
  return { entries, ignored };
}

export interface DictionaryMatch {
  wordId: string;
  from: string;
  to: string;
  /** The words either side, so a person can see what was changed and where. */
  context: string;
}

/**
 * Find every word the dictionary renames.
 *
 * Matching is on the *whole* word, never a substring: transcription emits one
 * Han character per word, so a rule for 「叉」 is a rule about that character
 * standing alone as a word — which is what it is when it means 「X」. Rewriting
 * inside longer words would turn 「交叉」 into 「交X」 with nothing to catch it.
 *
 * Deleted words are matched too. The cut can be changed afterwards, and a name
 * that comes back misspelled is worse than one corrected for nothing.
 */
export function matchDictionary(
  entries: readonly DictionaryEntry[],
  words: ReadonlyArray<{ id: string; text?: string; isGap?: boolean }>,
): DictionaryMatch[] {
  const byText = new Map(entries.map((entry) => [entry.from, entry.to]));
  const spoken = words.filter((word) => word.isGap !== true && (word.text ?? "").trim() !== "");
  const matches: DictionaryMatch[] = [];
  spoken.forEach((word, index) => {
    const from = (word.text ?? "").trim();
    const to = byText.get(from);
    if (to === undefined) return;
    const around = spoken.slice(Math.max(0, index - 4), index + 5)
      .map((item) => item.text ?? "")
      .join("");
    matches.push({ wordId: word.id, from, to, context: around });
  });
  return matches;
}
