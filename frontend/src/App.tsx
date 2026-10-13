import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import Navbar from './components/Navbar';
import { useAuth } from './context/Auth';
import { Spinner } from './components/ui';
import Home from './pages/Home';
import Download from './pages/Download';
import Login from './pages/Login';
import MyFiles from './pages/MyFiles';
import Admin from './pages/Admin';

function Guard({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <div className="flex h-64 items-center justify-center text-ink-muted"><Spinner className="h-5 w-5" /></div>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const loc = useLocation();
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <main className="flex-1">
        <div key={loc.pathname} className="animate-fade-in">
          <Routes location={loc}>
            <Route path="/" element={<Home />} />
            <Route path="/d/:id" element={<Download />} />
            <Route path="/login" element={<Login />} />
            <Route path="/files" element={<Guard><MyFiles /></Guard>} />
            <Route path="/admin" element={<Guard admin><Admin /></Guard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
      <footer className="border-t border-line py-6 text-center text-xs text-ink-muted">
        Files are stored temporarily and deleted automatically. Only open files you trust.
      </footer>
    </div>
  );
}
