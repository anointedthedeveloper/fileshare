import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/Auth';
import { Logo } from './ui';

export default function Navbar() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm transition-colors duration-150 ${isActive ? 'bg-stone-100 text-ink' : 'text-ink-muted hover:text-ink'}`;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="group flex items-center gap-2.5">
          <Logo className="h-7 w-7 transition-transform duration-300 group-hover:-rotate-6" />
          <span className="text-[15px] font-semibold tracking-tight">Parcel</span>
        </Link>
        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={link}>Send</NavLink>
          {user && <NavLink to="/files" className={link}>My files</NavLink>}
          {user?.role === 'admin' && <NavLink to="/admin" className={link}>Admin</NavLink>}
          <span className="mx-2 hidden h-4 w-px bg-line-strong sm:block" />
          {user ? (
            <div className="flex items-center gap-2">
              <span className="hidden max-w-[160px] truncate text-sm text-ink-muted sm:block">{user.email}</span>
              <button className="btn-ghost !px-3 !py-1.5" onClick={async () => { await logout(); nav('/'); }}>Sign out</button>
            </div>
          ) : (
            <NavLink to="/login" className="btn-secondary !px-3.5 !py-1.5">Sign in</NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}
