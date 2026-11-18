export interface Participant {
  readonly alias: string
  readonly sessionId: string
  readonly name: string
  readonly role: string
  readonly enabled?: boolean
}
