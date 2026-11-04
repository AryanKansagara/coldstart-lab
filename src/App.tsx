import { lazy, Suspense, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import Landing from './Landing.tsx'

const Tool = lazy(() => import('./Tool.tsx'))

export function go(href: string) {
  history.pushState({}, '', href)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
}

export function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    go(href)
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  )
}

function ThemeToggle() {
  const [mode, setMode] = useState(() => document.documentElement.dataset.themeMode ?? 'dark')
  const flip = () => {
    const next = mode === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.themeMode = next
    localStorage.setItem('themeMode', next)
    setMode(next)
  }
  return (
    <button className="icon-btn" onClick={flip} aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`} title="Toggle theme">
      {mode === 'dark' ? (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  )
}

function Header({ inApp }: { inApp: boolean }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand">
          <span className="mono-badge" aria-hidden>
            CS
          </span>
          <span className="brand-name">Cold Start Lab</span>
          <span className="brand-tag">for Modal</span>
        </Link>
        <nav className="nav-links">
          <a href="/#how">How it works</a>
          <a href="/#knobs">Knobs</a>
          <a href="https://modal.com/docs/guide/cold-start" target="_blank" rel="noreferrer">
            Modal docs ↗
          </a>
        </nav>
        <div className="nav-actions">
          <ThemeToggle />
          {!inApp && (
            <Link href="/app" className="btn btn-primary btn-sm">
              Open the lab
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>Built by Aryan Kansagara. Independent project, not affiliated with Modal.</span>
        <span className="mono dim">Everything runs in your browser. No traces leave the page.</span>
      </div>
    </footer>
  )
}

export default function App() {
  const [path, setPath] = useState(() => location.pathname)
  useEffect(() => {
    const on = () => setPath(location.pathname)
    addEventListener('popstate', on)
    return () => removeEventListener('popstate', on)
  }, [])
  const inApp = path === '/app' || path.startsWith('/app/')
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Header inApp={inApp} />
      <main id="main">
        {inApp ? (
          <Suspense fallback={<div className="lab-loading mono">Booting container…</div>}>
            <Tool />
          </Suspense>
        ) : (
          <Landing />
        )}
      </main>
      <Footer />
    </>
  )
}
