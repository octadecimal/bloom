import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireSession } from './RequireSession';
import { LoginScreen } from './LoginScreen';
import { RoomPicker } from './RoomPicker';
import { RoomRoute } from './RoomRoute';
import { Workbench } from '../Workbench';

// At the root route the Workbench is always rendered so plugins (e.g. Asset Board)
// are accessible without first entering a room.  The RoomPicker floats at the top
// of the screen; the rest of the workbench (including Asset Board below) is still
// interactive.
function HomeRoute() {
  return (
    <div style={{ position: 'relative', height: '100vh' }}>
      <Workbench />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
          zIndex: 100,
        }}
      >
        <div style={{ pointerEvents: 'auto', background: 'var(--background, #fff)', boxShadow: '0 2px 16px rgba(0,0,0,0.3)' }}>
          <RoomPicker />
        </div>
      </div>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<RequireSession />}>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/room/:roomId" element={<RoomRoute />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
