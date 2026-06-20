import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireSession } from './RequireSession';
import { LoginScreen } from './LoginScreen';
import { RoomPicker } from './RoomPicker';
import { RoomRoute } from './RoomRoute';

// The root route is a dedicated picker page: you choose (or create) a room here,
// then enter it to reach the Workbench. The Workbench lives only inside a room
// (see RoomRoute), which renders a "← Rooms" link back to this page.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<RequireSession />}>
        <Route path="/" element={<RoomPicker />} />
        <Route path="/room/:roomId" element={<RoomRoute />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
