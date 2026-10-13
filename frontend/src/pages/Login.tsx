import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/Auth';
import { Alert, Spinner } from '../components/ui';

export default function Login() {
  const { user, login, register, allowRegistration } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={loc.state?.from ?? '/files'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await (mode === 'login' ? login(email, password) : register(email, password));
      nav(loc.state?.from ?? '/files', { replace: true });
    } catch (e: any) {
      setErr(e?.status === 429 ? 'Too many attempts. Please try again later.' : e?.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 pb-24 pt-16 sm:pt-24">
      <form onSubmit={submit} className="card animate-fade-up space-y-4 p-7">
        <div>
          <h1 className="text-lg font-semibold">{mode === 'login' ? 'Welcome back' : 'Create an account'}</h1>
          <p className="mt-1 text-sm text-ink-muted">{mode === 'login' ? 'Sign in to manage the files you have shared.' : 'Accounts let you review and delete your uploads.'}</p>
        </div>
        {err && <Alert>{err}</Alert>}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" required minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          {mode === 'register' && <p className="mt-1.5 text-xs text-ink-muted">At least 8 characters.</p>}
        </div>
        <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner />}{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        {allowRegistration && (
          <p className="text-center text-sm text-ink-muted">
            {mode === 'login' ? "Don't have an account?" : 'Already registered?'}{' '}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }}>
              {mode === 'login' ? 'Create one' : 'Sign in'}
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
