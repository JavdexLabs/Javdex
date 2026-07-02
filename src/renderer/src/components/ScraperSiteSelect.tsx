interface Props {
  scrapers: string[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
}

/** Scraper site picker shared by video / actress detail pages. */
export default function ScraperSiteSelect({
  scrapers,
  value,
  onChange,
  disabled,
  title = '选择刮削站点'
}: Props): JSX.Element | null {
  if (!scrapers.length) return null

  return (
    <select
      className="select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title={title}
    >
      {scrapers.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  )
}
