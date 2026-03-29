/**
 * Notification message templates — Hebrew & English
 */

export function preEventMessage(title: string, minutesBefore: number, isHe: boolean) {
  const t = minutesBefore === 1
    ? (isHe ? 'דקה' : 'minute')
    : (isHe ? 'דקות' : 'minutes')
  return {
    title: isHe ? `⏰ בעוד ${minutesBefore} ${t}` : `⏰ In ${minutesBefore} ${t}`,
    body: title,
  }
}

export function morningBriefingMessage(
  eventCount: number,
  firstEventTime: string | null,
  urgentTaskCount: number,
  isHe: boolean
) {
  const parts: string[] = []
  if (isHe) {
    parts.push(`בוקר טוב! היום: ${eventCount} אירועים`)
    if (firstEventTime) parts.push(`ראשון ב-${firstEventTime}`)
    if (urgentTaskCount > 0) parts.push(`${urgentTaskCount} משימות דחופות`)
  } else {
    parts.push(`Good morning! Today: ${eventCount} events`)
    if (firstEventTime) parts.push(`first at ${firstEventTime}`)
    if (urgentTaskCount > 0) parts.push(`${urgentTaskCount} urgent tasks`)
  }
  return {
    title: isHe ? '🌅 בריפינג בוקר' : '🌅 Morning Briefing',
    body: parts.join(isHe ? '. ' : '. ') + '.',
  }
}

export function eveningReviewMessage(
  tomorrowEventCount: number,
  earliestTime: string | null,
  earliestTitle: string | null,
  unfinishedTaskCount: number,
  isHe: boolean
) {
  const parts: string[] = []
  if (isHe) {
    if (tomorrowEventCount > 0 && earliestTime) {
      parts.push(`מחר מתחיל ב-${earliestTime}${earliestTitle ? ` (${earliestTitle})` : ''}`)
    } else {
      parts.push('מחר ריק — יום חופשי!')
    }
    if (unfinishedTaskCount > 0) parts.push(`${unfinishedTaskCount} משימות לא הושלמו היום`)
  } else {
    if (tomorrowEventCount > 0 && earliestTime) {
      parts.push(`Tomorrow starts at ${earliestTime}${earliestTitle ? ` (${earliestTitle})` : ''}`)
    } else {
      parts.push('Tomorrow is clear — free day!')
    }
    if (unfinishedTaskCount > 0) parts.push(`${unfinishedTaskCount} tasks unfinished today`)
  }
  return {
    title: isHe ? '🌙 סיכום ערב' : '🌙 Evening Review',
    body: parts.join('. ') + '.',
  }
}

export function taskNudgeMessage(freeMinutes: number, taskTitle: string, isHe: boolean) {
  const hours = Math.floor(freeMinutes / 60)
  const mins = freeMinutes % 60
  const timeStr = hours > 0
    ? (isHe ? `${hours} שעות${mins > 0 ? ` ו-${mins} דקות` : ''}` : `${hours}h${mins > 0 ? ` ${mins}m` : ''}`)
    : (isHe ? `${mins} דקות` : `${mins}m`)
  return {
    title: isHe ? '💡 זמן פנוי' : '💡 Free Time',
    body: isHe
      ? `יש לך ${timeStr} פנויות — רוצה לעבוד על "${taskTitle}"?`
      : `You have ${timeStr} free — work on "${taskTitle}"?`,
  }
}
