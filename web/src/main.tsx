import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Copilot } from './Copilot'
import { Screen } from './Screen'
import { Start } from './Start'
import './styles.css'

// Three pages, picked from the path: /app/, /app/live/:id, /app/screen/:id
const path = location.pathname.replace(/^\/app\/?/, '')
const [page, id] = path.split('/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{page === 'live' && id ? <Copilot id={id} /> : page === 'screen' && id ? <Screen id={id} /> : <Start />}</StrictMode>,
)
