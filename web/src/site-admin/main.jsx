// The website's admin — its own small app at /website-admin, apart from the
// field app: a sign-in, then Pages · News · Events · Team · Store · Orders ·
// Settings (the same editors as before, web/src/pages/Website*.jsx). It
// runs on whichever service serves the site (lib/serve.js), with the same
// accounts and roles: managers and staff edit, treasurers see Orders.
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../app.css';
import SiteAdmin from './SiteAdmin.jsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, error) => (error?.status === 401 || error?.status === 404 ? false : n < 1), refetchOnWindowFocus: false, staleTime: 15_000 } },
});

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter basename="/website-admin">
      <SiteAdmin />
    </BrowserRouter>
  </QueryClientProvider>,
);
