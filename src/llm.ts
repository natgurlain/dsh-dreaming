/**
 * Tool-less model calls with a JSON answer and a hard budget.
 *
 * A dream reads untrusted transcripts, so it never runs as an agent with
 * tools: every pass is one `ctx.llm.stream` call whose output is parsed and
 * validated in code. A tool call in the stream fails the call.
 *
 * @module @natgurlain/dsh-dreaming/llm
 */

/** The slice of DSH's LLM service used here. */
export interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    temperature?: number
    signal?: AbortSignal
    purpose?: string
  }): AsyncIterable<unknown>
}

export function isLlmLike(value: unknown): value is LlmLike {
  return typeof value === 'object' && value !== null && typeof (value as { stream?: unknown }).stream === 'function'
}

export interface ModelChoice {
  provider: string
  model: string
}

/** Limits for one dream. */
export interface Budget {
  maxCalls: number
  maxInputChars: number
  deadline: number
}

export class BudgetExceeded extends Error {
  constructor(what: string) {
    super(`dream budget exhausted: ${what}`)
    this.name = 'BudgetExceeded'
  }
}

/** Collect text deltas; fail on tool calls or an abnormal finish. */
export async function readText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ''
  let finished = false
  for await (const raw of stream) {
    const chunk = raw as { type?: unknown; text?: unknown; reason?: { kind?: unknown; failure?: { message?: unknown } } }
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'tool-call-delta') throw new Error('the dream model tried to call a tool')
    else if (chunk.type === 'finish') {
      finished = true
      if (chunk.reason?.kind !== 'stop' && chunk.reason?.kind !== 'length') {
        const detail = typeof chunk.reason?.failure?.message === 'string' ? `: ${chunk.reason.failure.message}` : ''
        throw new Error(`the dream model ended with ${String(chunk.reason?.kind)}${detail}`)
      }
    }
  }
  if (!finished) throw new Error('the dream model stream ended without a finish')
  return text
}

/** Pull the first JSON object out of a reply (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply')
  return JSON.parse(body.slice(start, end + 1))
}

/** Calls the model within one dream's budget. */
export class DreamModel {
  calls = 0
  inputChars = 0

  constructor(
    private readonly llm: LlmLike,
    private readonly choice: ModelChoice,
    private readonly budget: Budget,
    private readonly signal: AbortSignal,
    private readonly callTimeoutMs: number,
  ) {}

  /** Whether another call of about `chars` input still fits. */
  fits(chars: number): boolean {
    return this.calls < this.budget.maxCalls && this.inputChars + chars <= this.budget.maxInputChars && Date.now() < this.budget.deadline
  }

  private async call(system: string, user: string): Promise<string> {
    this.signal.throwIfAborted()
    if (this.calls >= this.budget.maxCalls) throw new BudgetExceeded('model calls')
    if (this.inputChars + system.length + user.length > this.budget.maxInputChars) throw new BudgetExceeded('input size')
    if (Date.now() >= this.budget.deadline) throw new BudgetExceeded('time')
    this.calls += 1
    this.inputChars += system.length + user.length
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.callTimeoutMs)])
    return readText(this.llm.stream({
      provider: this.choice.provider,
      model: this.choice.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0,
      signal,
      purpose: 'dreaming',
    }))
  }

  /** Ask for JSON, validate with `parse`, retry once with the error shown. */
  async json<T>(system: string, user: string, parse: (value: unknown) => T): Promise<T> {
    const first = await this.call(system, user)
    try {
      return parse(extractJson(first))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retry = await this.call(system, `${user}\n\nYour previous reply could not be used (${message}). Reply again with only the JSON object described above.`)
      return parse(extractJson(retry))
    }
  }
}
