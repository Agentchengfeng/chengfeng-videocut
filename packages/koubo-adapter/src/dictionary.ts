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

/** Any of these separates the heard spelling from the written one. */
const ARROW = /\s*(?:->|→|=>|\t|=)\s*/;

/**
 * Read a dictionary file.
 *
 * A rule is a Markdown list item: `- heard -> written`. Everything else is
 * prose and is ignored without comment.
 *
 * That restriction is the whole design. The first version treated every line as
 * a candidate rule, so that a bare list of rules would work — and then reading
 * this project's own dictionary, which is a document explaining itself, it
 * reported thirty lines of prose as unreadable *and* parsed three sentences
 * into rules, because a sentence containing a tab or an `=` looks exactly like
 * `from = to`. A file that is meant to be read by a person has to say which
 * lines are the data.
 *
 * A list item that cannot be read is still reported: a typo in a rule is
 * otherwise indistinguishable from a name that never came up.
 */
export function parseDictionary(source: string): ParsedDictionary {
  const entries: DictionaryEntry[] = [];
  const ignored: ParsedDictionary["ignored"] = [];
  const seen = new Set<string>();
  source.split(/\r?\n/).forEach((raw, index) => {
    if (!/^\s*[-*+]\s+/.test(raw)) return;
    const line = raw.replace(/#.*$/, "").replace(/^\s*[-*+]\s+/, "").trim();
    if (!line) return;
    const parts = line.split(ARROW);
    if (parts.length !== 2) {
      ignored.push({ line: index + 1, text: raw.trim() });
      return;
    }
    const from = (parts[0] ?? "").replace(/^[`「"']|[`」"']$/g, "").trim();
    const to = (parts[1] ?? "").replace(/^[`「"']|[`」"']$/g, "").trim();
    if (!from || from === to) {
      ignored.push({ line: index + 1, text: raw.trim() });
      return;
    }
    // First rule wins, so a project's own additions can be listed above the
    // general ones without the later duplicate silently overriding them.
    if (seen.has(from)) return;
    seen.add(from);
    entries.push({ from, to });
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
