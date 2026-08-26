import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Theme fonts, bundled locally (offline-first — no Google Fonts at runtime).
// Which theme uses which family is defined in index.css / the design manifest
// (design/mockup-fun-themes-v4.html).
import '@fontsource/ibm-plex-mono/400.css'   // Matrix — UI
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/share-tech-mono/400.css' // Matrix — display
import '@fontsource/baloo-2/400.css'         // Mushroom Kingdom — UI
import '@fontsource/baloo-2/500.css'
import '@fontsource/baloo-2/600.css'
import '@fontsource/baloo-2/700.css'
import '@fontsource/baloo-2/800.css'         // Mushroom Kingdom — logo wordmark
import '@fontsource/press-start-2p/400.css'  // Mushroom Kingdom — display
import '@fontsource/karla/400.css'           // Hyrule — UI
import '@fontsource/karla/500.css'
import '@fontsource/karla/600.css'
import '@fontsource/karla/700.css'
import '@fontsource/marcellus/400.css'       // Hyrule — display
import '@fontsource/dm-sans/400.css'         // Ink Blue — UI
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/space-grotesk/400.css'   // Ink Blue — display
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/plus-jakarta-sans/700.css' // Basic — logo wordmark only
import App from './App.tsx'
import { applyTheme, getStoredTheme } from './theme'

// Apply the saved color theme before the first render to avoid a flash of
// the default palette.
applyTheme(getStoredTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
