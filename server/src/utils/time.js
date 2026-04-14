export const SLOT_HOURS = 0.5;
export const SLOTS_PER_DAY = 48;

export function getSlotIndex(date) {
  return date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0);
}

export function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function getYearSlots(year) {
  const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));
  const slots = [];

  for (let t = start.getTime(); t < end.getTime(); t += SLOT_HOURS * 60 * 60 * 1000) {
    slots.push(new Date(t));
  }

  return slots;
}

export function slotInWindow(slot, startSlot, endSlot) {
  if (startSlot <= endSlot) {
    return slot >= startSlot && slot < endSlot;
  }

  return slot >= startSlot || slot < endSlot;
}
