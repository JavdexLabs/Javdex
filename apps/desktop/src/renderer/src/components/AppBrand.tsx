/** Sidebar / chrome wordmark for Javdex. */
export default function AppBrand(): JSX.Element {
  return (
    <div className="brand" aria-label="Javdex">
      <span className="brand-wordmark" aria-hidden="true">
        <span className="brand-wordmark-jav">Jav</span>
        <span className="brand-wordmark-dex">dex</span>
      </span>
    </div>
  )
}
