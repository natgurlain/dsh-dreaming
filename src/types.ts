/**
 * Records shared by the store and the dream pipeline.
 *
 * @module @natgurlain/dsh-dreaming/types
 */

/** What a note is about. */
export const NOTE_KINDS = ['preference', 'fact', 'procedure', 'correction', 'pitfall'] as const
export type NoteKind = typeof NOTE_KINDS[number]

/** Who a piece of evidence came from. */
export const SPEAKERS = ['user', 'agent', 'tool'] as const
export type Speaker = typeof SPEAKERS[number]

/** `user`: the user said it. `inferred`: the agent concluded it. */
export type Trust = 'user' | 'inferred'

/** Where a note came from: one session and the event seqs that support it. */
export interface NoteSource {
  sessionId: string
  seqs: number[]
  /** The session read untrusted content (web pages, fetched URLs, MCP tools). */
  tainted?: true
}

/** One memory note (layer 2). */
export interface Note {
  id: string
  text: string
  kind: NoteKind
  trust: Trust
  sources: NoteSource[]
  firstSeen: string
  lastConfirmed: string
  /** Ids of notes this one replaced. */
  supersedes?: string[]
}

/** One wiki page (layer 3). */
export interface WikiPage {
  slug: string
  title: string
  body: string
}

/** The full contents of one memory version. */
export interface MemorySnapshot {
  notes: Note[]
  wiki: WikiPage[]
  /** Ids of notes rendered into the injected context (layer 4). */
  injected: string[]
}

/** A memory store: `global` or one workspace. */
export interface StoreRef {
  key: string
  /** The workspace path, absent for `global`. */
  cwd?: string
}

/** A candidate memory extracted from one transcript chunk. */
export interface Candidate {
  id: string
  text: string
  kind: NoteKind
  speaker: Speaker
  confidence: number
  sessionId: string
  seqs: number[]
  tainted: boolean
}

/** Dream lifecycle, mirroring Anthropic's dreams API. */
export type DreamStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled'

/** What happened to a staged dream. */
export type DreamOutcome = 'applied' | 'discarded'

/** One dream, as recorded in `dreams/<id>/dream.json`. */
export interface DreamRecord {
  id: string
  store: StoreRef
  status: DreamStatus
  createdAt: string
  updatedAt: string
  /** The HEAD version the dream started from (0: empty store). */
  baseVersion: number
  instructions?: string
  /** Sessions read, with the last seq covered for each. */
  sessions: Array<{ sessionId: string; throughSeq: number; tainted: boolean }>
  progress: string
  /** Budget ran out before every session was read. */
  truncated?: true
  error?: string
  outcome?: DreamOutcome
  /** The version an applied dream became. */
  appliedVersion?: number
  stats?: DreamStats
}

/** Counts reported for a finished dream. */
export interface DreamStats {
  llmCalls: number
  inputChars: number
  candidates: number
  quarantined: number
  added: number
  updated: number
  merged: number
  dropped: number
  confirmed: number
  rejectedOps: number
}
