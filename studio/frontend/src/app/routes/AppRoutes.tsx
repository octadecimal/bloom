import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireSession } from './RequireSession';
import { LoginScreen } from './LoginScreen';
import { RoomPicker } from './RoomPicker';
import { RoomRoute } from './RoomRoute';

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
