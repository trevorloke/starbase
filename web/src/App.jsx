// Routes + auth gate. Real URLs are the point: every screen, form-open state,
// selected door, and preselected donor lives in the address bar. Screens past
// Today load on demand — the map (Leaflet) is the heaviest and phones in the
// field shouldn't pay for it until they open it.
// Desk-only screens sit under one role guard: a volunteer who types one of
// those URLs lands back on Today (the server refuses their data anyway).
import { lazy } from 'react';
import { Routes, Route, Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, noAnswer } from './api.js';
import Shell, { isDesk } from './Shell.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Today from './pages/Today.jsx';
const MapPage = lazy(() => import('./pages/Map.jsx'));
const TextingInbox = lazy(() => import('./pages/TextingInbox.jsx'));
const TextingThread = lazy(() => import('./pages/TextingThread.jsx'));
const TextingSettings = lazy(() => import('./pages/TextingSettings.jsx'));
const People = lazy(() => import('./pages/People.jsx'));
const Person = lazy(() => import('./pages/Person.jsx'));
const Shifts = lazy(() => import('./pages/Shifts.jsx'));
const Money = lazy(() => import('./pages/Money.jsx'));
const Signs = lazy(() => import('./pages/Signs.jsx'));
const Outreach = lazy(() => import('./pages/Outreach.jsx'));
const Filings = lazy(() => import('./pages/Filings.jsx'));
const Team = lazy(() => import('./pages/Team.jsx'));
const ImportPeople = lazy(() => import('./pages/ImportPeople.jsx'));
const Turfs = lazy(() => import('./pages/Turfs.jsx'));
const Receipts = lazy(() => import('./pages/Receipts.jsx'));
const ReceiptsOne = lazy(() => import('./pages/ReceiptsOne.jsx'));
const Ladders = lazy(() => import('./pages/Ladders.jsx'));
const LaddersEdit = lazy(() => import('./pages/LaddersEdit.jsx'));
const LaddersFollowups = lazy(() => import('./pages/LaddersFollowups.jsx'));
const Surveys = lazy(() => import('./pages/Surveys.jsx'));
const SurveysEdit = lazy(() => import('./pages/SurveysEdit.jsx'));
const SurveysResults = lazy(() => import('./pages/SurveysResults.jsx'));
const RatingScale = lazy(() => import('./pages/RatingScale.jsx'));
const Fields = lazy(() => import('./pages/Fields.jsx'));
const MyPeople = lazy(() => import('./pages/MyPeople.jsx'));
const PeopleConnected = lazy(() => import('./pages/PeopleConnected.jsx'));
import Join from './pages/Join.jsx';

// No answer from the server (wifi with no internet, a restart) is not a
// sign-out: the app opens as who signed in here (main.jsx), on the copies
// kept for them, and asks again every 15 s. Only a refusal goes to Sign in.
const askAgain = (q) => ((q.state.data !== undefined && q.state.dataUpdatedAt === 0)
  || (q.state.status === 'error' && noAnswer(q.state.error)) ? 15_000 : false);
function RequireAuth() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => apiGet('/auth/me'),
    retry: false,
    staleTime: 60_000,
    refetchInterval: askAgain,
  });
  if (me.isLoading) return null;
  if (me.isError && !(noAnswer(me.error) && me.data)) return <Navigate to="/login" replace />;
  return <Shell me={me.data} />;
}

// Staff, treasurers and managers only. The Shell's outlet context is passed
// straight through, so pages keep reading { me } from useOutletContext().
function DeskOnly() {
  const ctx = useOutletContext();
  if (!isDesk(ctx?.me)) return <Navigate to="/" replace />;
  return <Outlet context={ctx} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/join/:token" element={<Join />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Today />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/calls" element={<People key="calls" mode="calls" />} />
        <Route path="/people" element={<People />} />
        <Route path="/people/:id" element={<Person />} />
        <Route path="/shifts" element={<Shifts />} />
        <Route path="/shifts/:id" element={<Shifts />} />
        <Route path="/turfs" element={<Turfs />} />
        <Route path="/turfs/:id" element={<Turfs />} />
        {/* Volunteers get the sign crew's "Signs to put up" view. */}
        <Route path="/signs" element={<Signs />} />
        {/* Texts: volunteers see the conversations they started; the desk sees all. */}
        <Route path="/inbox" element={<TextingInbox />} />
        <Route path="/inbox/:id" element={<TextingThread />} />
        {/* The people you know: every role (the server sends only your own). */}
        <Route path="/my-people" element={<MyPeople />} />
        <Route element={<DeskOnly />}>
          <Route path="/people/import" element={<ImportPeople />} />
          <Route path="/people/fields" element={<Fields />} />
          <Route path="/people/connected" element={<PeopleConnected />} />
          <Route path="/inbox/settings" element={<TextingSettings />} />
          <Route path="/money" element={<Money />} />
          <Route path="/money/receipts" element={<Receipts />} />
          <Route path="/money/receipts/:id" element={<ReceiptsOne />} />
          <Route path="/outreach" element={<Outreach />} />
          <Route path="/outreach/:tab" element={<Outreach />} />
          <Route path="/filings" element={<Filings />} />
          <Route path="/team" element={<Team />} />
          <Route path="/ladders" element={<Ladders />} />
          <Route path="/ladders/:id" element={<LaddersEdit />} />
          <Route path="/follow-ups" element={<LaddersFollowups />} />
          <Route path="/surveys" element={<Surveys />} />
          <Route path="/surveys/:id" element={<SurveysEdit />} />
          <Route path="/surveys/:id/results" element={<SurveysResults />} />
          <Route path="/rating-scale" element={<RatingScale />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
