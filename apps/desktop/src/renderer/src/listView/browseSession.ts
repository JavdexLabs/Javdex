/** Latest request belongs to one mounted search/object scope, including A → B → A. */
export function createBrowseSession(initialScope: string) {
  let scope = initialScope
  let generation = 0
  let request = 0
  let active = true
  return {
    setScope(next: string): void { if (scope !== next) { scope = next; generation++ } },
    setActive(next: boolean): void { if (active !== next) { active = next; generation++ } },
    begin(expectedScope: string) {
      return { scope: expectedScope, generation, request: expectedScope === scope && active ? ++request : -1 }
    },
    isCurrent(ticket: { scope: string; generation: number; request: number }): boolean {
      return active && ticket.scope === scope && ticket.generation === generation && ticket.request === request
    }
  }
}
