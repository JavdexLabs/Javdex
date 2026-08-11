import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import QueryProvider from './query/QueryProvider'
import { restoreCachedPrivacyMode } from './privacyMode'
// Global styles remain order-sensitive while shared legacy selectors are being separated.
import './styles.css'
import './styles/navigation-controls.css'
import './styles/library-content.css'
import './styles/media-details.css'
import './styles/entity-browsing.css'
import './styles/settings-overview.css'
import './styles/settings-library.css'
import './styles/settings-plugins.css'
import './styles/plugin-development-shell.css'
import './styles/settings-services.css'
import './styles/plugin-development-workbench.css'
import './styles/feedback-overlays.css'
import './styles/entity-editors.css'
import './styles/settings-tools.css'
import './styles/conflict-review.css'
import './styles/shell.css'
import './styles/detail-surfaces.css'
import './styles/workspaces.css'

restoreCachedPrivacyMode()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <QueryProvider>
        <App />
      </QueryProvider>
    </HashRouter>
  </React.StrictMode>
)
