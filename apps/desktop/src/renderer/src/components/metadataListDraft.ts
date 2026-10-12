export interface MetadataListDraft {
  values: string[]
  input: string
}

export function metadataListKey(value: string): string {
  return value.trim().normalize('NFC').toLocaleLowerCase()
}

export function splitMetadataList(value: string): string[] {
  return value.split(/[,，、\r\n]+/).map(part => part.trim()).filter(Boolean)
}

export function appendMetadataList(values: string[], input: string | string[]): { values: string[]; duplicates: number } {
  const next = [...values]
  const seen = new Set(next.map(metadataListKey))
  let duplicates = 0
  for (const part of typeof input === 'string' ? splitMetadataList(input) : input) {
    const key = metadataListKey(part)
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    next.push(part)
  }
  return { values: next, duplicates }
}

export function metadataListValues(draft: MetadataListDraft): string[] {
  return appendMetadataList(draft.values, draft.input).values
}
