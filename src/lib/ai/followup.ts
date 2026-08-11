/**
 * followup.ts — one definition of "that reply was too thin to ship".
 *
 * This existed twice, with two different rules, and the weaker copy was on the
 * default provider. The Anthropic path only re-prompted when the model returned
 * *nothing at all*; the OpenAI path additionally caught the short-but-nonempty
 * case (`length < 30 && iterations > 1`). So the common real failure — Claude
 * runs three tools, then answers "בוצע!" — sailed straight through on the path
 * every user was actually on, and the person saw events appear with no
 * explanation of what had been decided or why.
 *
 * The fix is not "copy the better rule into the other branch": two copies is how
 * it diverged the first time. The rule lives here, both providers call it, and
 * there is no second place for it to drift to.
 *
 * `toolCallsMade > 0` rather than `iterations > 1` deliberately: iteration count
 * is an artefact of loop bookkeeping, while "did this turn actually do
 * something" is the property that makes a bare acknowledgement unacceptable. A
 * short answer to a short question is fine; a short answer after writing to the
 * user's calendar is not.
 */

/** Below this many characters, a post-tool reply is an acknowledgement, not an answer. */
export const FOLLOWUP_MIN_CHARS = 30

export function needsFollowup(content: string | null | undefined, toolCallsMade: number): boolean {
  if (toolCallsMade <= 0) return false
  return (content ?? '').trim().length < FOLLOWUP_MIN_CHARS
}

/** What we ask for on the second pass. The tool results are already in the transcript. */
export function followupPrompt(isHe: boolean): string {
  return isHe
    ? 'תן תשובה מלאה על סמך תוצאות הכלים למעלה: מה בדיוק עשית, מה מצאת, ולמה בחרת ככה. אם משהו לא הצליח — אמור את זה במפורש. ענה בעברית.'
    : 'Give a full answer based on the tool results above: what exactly you did, what you found, and why you chose it. If something failed, say so explicitly.'
}
