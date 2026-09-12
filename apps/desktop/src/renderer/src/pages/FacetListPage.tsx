import { SearchX } from 'lucide-react'
import { useParams } from 'react-router-dom'
import EmptyState from '../components/EmptyState'
import { UI_ICON_SM } from '../components/iconDefaults'
import DirectorListPage from './DirectorListPage'
import OrganizationListPage from './OrganizationListPage'
import SeriesListPage from './SeriesListPage'

export default function FacetListPage(): JSX.Element {
  const { type } = useParams()
  if (type === 'maker' || type === 'publisher') {
    return <OrganizationListPage role={type} />
  }
  if (type === 'director') return <DirectorListPage />
  if (type === 'series') return <SeriesListPage />
  return (
    <EmptyState
      icon={<SearchX {...UI_ICON_SM} aria-hidden />}
      title="未知分类"
      description="当前分类参数无效。"
    />
  )
}
