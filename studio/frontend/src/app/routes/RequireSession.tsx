import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../../session/SessionContext';

export function RequireSession() {
  const { username } = useSession();
  const location = useLocation();
  if (!username) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }
  return <Outlet />;
}
