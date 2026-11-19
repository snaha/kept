import type { ToolContract, ToolIo, ToolName, ToolSchema } from './tools'

export const TOOL_NAMES: readonly ToolName[]
export const TOOL_CONTRACTS: { readonly [Name in ToolName]: ToolContract<Name> }
export const MAX_TOOL_RESULTS: number
export const DEFAULT_TOOL_RESULTS: number
export const MAX_QUERY_LENGTH: number
export const MAX_RANK_CANDIDATES: number
export const MAX_QUEUE_LENGTH: number
export const MAX_QUEUE_SEEDS: number
// Returns the first violation as a path and a reason, or undefined when the value fits.
export function schemaViolation(schema: ToolSchema, value: unknown, path?: string): string | undefined
// Both return the value they were given, or throw naming the tool and the violation.
export function validateToolInput<Name extends ToolName>(name: Name, input: unknown): ToolIo[Name]['input']
export function validateToolOutput<Name extends ToolName>(name: Name, output: unknown): ToolIo[Name]['output']
