interface Props {
  value: number
  onChange?: (rating: number) => void
  size?: number
}

/** Five-star rating. Read-only unless onChange is provided. */
export default function StarRating({ value, onChange, size = 16 }: Props): JSX.Element {
  const interactive = !!onChange
  return (
    <div className="stars" style={{ fontSize: size }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`star ${n <= value ? 'filled' : ''} ${interactive ? 'interactive' : ''}`}
          style={{ fontSize: size }}
          onClick={
            interactive
              ? (e) => {
                  e.stopPropagation()
                  // Clicking the current rating again clears it.
                  onChange?.(n === value ? 0 : n)
                }
              : undefined
          }
          disabled={!interactive}
          aria-label={`${n} 星`}
        >
          ★
        </button>
      ))}
    </div>
  )
}
