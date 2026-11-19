/** One operation of a change, compared: what it changed, with the value before and after. */
export type ActivityOperation = { index: number; label: string; before?: string; after?: string; undone?: boolean }
/**
 * One change Kept or the user made. `undone` entries stay listed as a receipt.
 * `route` names what proposed an automated change, and `operations` compares each part of it.
 */
export type ActivityEntry = {
  id: string; at: number; actor: 'you' | 'kept'; route?: string; summary: string; detail?: string; undone?: boolean; undoable?: boolean
  operations?: ActivityOperation[]
}
