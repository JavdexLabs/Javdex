import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import QueryProvider from './query/QueryProvider'
import { restoreCachedPrivacyMode } from './privacyMode'
import './styles/global.css'

restoreCachedPrivacyMode()

const router = createHashRouter([{ path: '*', element: <QueryProvider><App /></QueryProvider> }])

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
)
