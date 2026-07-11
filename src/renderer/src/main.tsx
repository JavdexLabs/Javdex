import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import QueryProvider from './query/QueryProvider'
import './styles.css'
import './styles/shell.css'
import './styles/detail-surfaces.css'
import './styles/workspaces.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <QueryProvider>
        <App />
      </QueryProvider>
    </HashRouter>
  </React.StrictMode>
)
