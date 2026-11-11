import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { auth } from './lib/api';
import { getLang } from './lib/i18n';
import Auth from './pages/Auth';
import Meetings from './pages/Meetings';
import NewMeeting from './pages/NewMeeting';
import Host from './pages/Host';
import Screen from './pages/Screen';
import Participant from './pages/Participant';
import Summary from './pages/Summary';
import Shared from './pages/Shared';
import './styles.css';

document.documentElement.lang = getLang();

function RequireHost({ children }: { children: React.ReactElement }) {
  return auth.hostToken() ? children : <Navigate to="/login" replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to={auth.hostToken() ? '/meetings' : '/login'} replace />} />
        <Route path="/login" element={<Auth />} />
        <Route path="/meetings" element={<RequireHost><Meetings /></RequireHost>} />
        <Route path="/meetings/new" element={<RequireHost><NewMeeting /></RequireHost>} />
        <Route path="/m/:id/host" element={<RequireHost><Host /></RequireHost>} />
        <Route path="/m/:id/screen" element={<Screen />} />
        <Route path="/m/:id/summary" element={<Summary />} />
        <Route path="/m/:id" element={<Participant />} />
        <Route path="/s/:token" element={<Shared />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
