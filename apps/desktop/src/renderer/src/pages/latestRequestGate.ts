export interface LatestRequestGate {
  next(): number
  isLatest(requestId: number): boolean
  invalidate(requestId: number): void
}

export function createLatestRequestGate(): LatestRequestGate {
  let current = 0
  return {
    next(): number {
      current += 1
      return current
    },
    isLatest(requestId): boolean {
      return requestId === current
    },
    invalidate(requestId): void {
      if (requestId === current) current += 1
    }
  }
}
