/**
 * Line a written script up against what was actually said.
 *
 * Transcription mishears proper nouns in ways no dictionary can fix from the audio
 * alone: on one real recording 「X」 came back as 「叉」 seven times, and 「Tibo」 as
 * both 「Tibbo」 and 「tibor」. The script the speaker wrote has all of them spelled
 * right — it just has no timing.
 *
 * So align the two: the transcript owns *when*, the script owns *how it is spelled*.
 * Neither is asked to do the other's job.
 *
 * **Nothing here decides anything.** It reports what lines up and what does not; the
 * mismatches are handed back for a person to look at rather than guessed. A speaker
 * ad-libs, repeats, and abandons sentences — a script is a strong hint about
 * spelling, never a claim about what was said.
 */

export interface AlignableWord {
  id: string;
  text: string;
  isGap?: boolean;
}

export interface ScriptCorrection {
  wordId: string;
  from: string;
  to: string;
}

export interface ScriptAlignment {
  corrections: ScriptCorrection[];
  /** Spoken words no part of the script could be matched to. */
  unmatched: Array<{ wordId: string; text: string }>;
  matchedWords: number;
  totalWords: number;
}

/**
 * Reduce a written document to the words that were spoken aloud.
 *
 * Image lines, link targets and markdown punctuation were never said, and leaving
 * them in makes the aligner match speech against furniture.
 */
export function scriptSpeech(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^```[\s\S]*?^```/gm, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, " ")
    .replace(/^\s*\/\/\/\s*$/gm, " ")
    .replace(/[*_~>]/g, " ");
}

/** Characters that carry sound. Punctuation and spacing were never pronounced. */
function soundCarrying(value: string): boolean {
  return /[\p{Script=Han}\p{Letter}\p{Number}]/u.test(value);
}

interface Token {
  /** Lowercased, for comparison only. */
  key: string;
  /** As written, for the correction. */
  raw: string;
}

function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  for (const character of [...value]) {
    if (!soundCarrying(character)) continue;
    tokens.push({ key: character.toLowerCase(), raw: character });
  }
  return tokens;
}

/**
 * How much context either side of a term must match before it is trusted.
 *
 * Two sound-carrying characters. One is not enough — 「的」 next to a term matches
 * everywhere — and three starts missing terms that sit near a sentence edge.
 */
const CONTEXT_CHARS = 2;

/** Terms worth correcting: anything containing a letter, as the script spells it. */
export function scriptTerms(markdown: string): string[] {
  const speech = scriptSpeech(markdown);
  const seen = new Set<string>();
  for (const match of speech.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
    const term = match[0];
    if (term.length >= 1) seen.add(term);
  }
  return [...seen];
}

interface Placed {
  key: string;
  raw: string;
  /** Index of the spoken word this character came from, or -1 in the script. */
  owner: number;
}

function place(value: string, owner: number): Placed[] {
  const out: Placed[] = [];
  for (const character of [...value]) {
    if (!soundCarrying(character)) continue;
    out.push({ key: character.toLowerCase(), raw: character, owner });
  }
  return out;
}

/**
 * Correct the terms the transcript misheard, using the script's own spelling.
 *
 * **Deliberately not a full alignment.** Two attempts at aligning the whole script
 * to the whole transcript failed on real data, and the reason is the data: the
 * script is a written article covering 67% of what was said (580 characters against
 * 866), opening with a title that was never read aloud. There is no global
 * correspondence to find.
 *
 * There does not need to be. Everything that needs correcting is a proper noun, and
 * a proper noun is exactly the thing the script spells unambiguously. So look up
 * each term where it *sits*: find the two characters before and after it in the
 * script, find the same pair in what was heard, and whatever the transcript put
 * between them is the mishearing. 「刷 X 了」 finds 「刷 叉 了」 without knowing
 * anything about how 「X」 sounds in Chinese.
 *
 * A term whose context appears more than once is skipped rather than guessed at.
 */
export function alignScriptToWords(
  markdown: string,
  words: readonly AlignableWord[],
): ScriptAlignment {
  const spoken = words.filter((word) => word.isGap !== true && word.text.trim() !== "");
  const heard: Placed[] = [];
  for (const [index, word] of spoken.entries()) heard.push(...place(word.text, index));
  const script = place(scriptSpeech(markdown), -1);
  const heardKeys = heard.map((item) => item.key).join("");

  const corrections: ScriptCorrection[] = [];
  const proposed = new Set<string>();
  const ambiguous: string[] = [];

  for (const term of scriptTerms(markdown)) {
    const termKeys = term.toLowerCase();
    for (let at = 0; at + termKeys.length <= script.length; at += 1) {
      const here = script.slice(at, at + termKeys.length).map((item) => item.key).join("");
      if (here !== termKeys) continue;
      const before = script.slice(Math.max(0, at - CONTEXT_CHARS), at)
        .map((item) => item.key).join("");
      const after = script.slice(at + termKeys.length, at + termKeys.length + CONTEXT_CHARS)
        .map((item) => item.key).join("");
      // A term at the very edge of the document has less context to offer. One
      // character each side is still evidence; none is not.
      if (before.length === 0 || after.length === 0) continue;

      // The heard text between the same two anchors. More than one place with this
      // context means the evidence does not single anything out.
      const hits: Array<{ from: number; to: number }> = [];
      let cursor = heardKeys.indexOf(before);
      while (cursor !== -1) {
        const gapStart = cursor + before.length;
        // The mishearing is short: a term rendered as a character or two, not a
        // sentence. Anything longer is the speaker having said something else.
        const limit = Math.min(gapStart + termKeys.length + 4, heardKeys.length);
        const found = heardKeys.indexOf(after, gapStart);
        if (found !== -1 && found <= limit && found > gapStart) {
          hits.push({ from: gapStart, to: found });
        }
        cursor = heardKeys.indexOf(before, cursor + 1);
      }
      if (hits.length !== 1) {
        if (hits.length > 1) ambiguous.push(term);
        continue;
      }
      const { from, to } = hits[0]!;
      const owners = new Set(heard.slice(from, to).map((item) => item.owner));
      if (owners.size !== 1) continue;
      const owner = [...owners][0]!;
      const word = spoken[owner]!;
      // The whole word must sit inside the gap: replacing half of one would corrupt
      // the rest of the sentence.
      const wordSpan = heard.reduce((total, item) => (item.owner === owner ? total + 1 : total), 0);
      if (wordSpan !== to - from) continue;
      if (word.text === term) continue;
      const key = `${word.id}:${term}`;
      if (proposed.has(key)) continue;
      proposed.add(key);
      corrections.push({ wordId: word.id, from: word.text, to: term });
    }
  }

  const corrected = new Set(corrections.map((correction) => correction.wordId));
  return {
    corrections,
    unmatched: ambiguous.map((term) => ({ wordId: "", text: term })),
    matchedWords: corrected.size,
    totalWords: spoken.length,
  };
}
