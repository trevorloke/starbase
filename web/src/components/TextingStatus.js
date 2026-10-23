// Is texting (and calling) through the campaign's Twilio number on? Every
// screen that offers a text or a call asks this one query, and it is kept on
// this phone with the other field data (OfflineCache.js), so a phone with no
// signal still knows texts go from the campaign's number — and never quietly
// swaps in its own Messages or dialler.
//
//   const q = useTextingStatus(me);
//   textingOn(q) → { sms, voice }: true / false, or null when nobody knows
//                  yet (no signal and nothing kept on this phone)
//   statusOffline(q) → no signal: what's shown is the phone's copy (or nothing)
//   useOnline() → the phone's own online / offline, as it changes
//   useTextQueue(me, on) → the Text list's { away, replied } person ids
//   useTextingPerson(personId, on) → the card's /texting/people/:id
//   callsCard(person, 'text' | 'phone') → that person's card on Calls (the
//                  profile's and the door card's Call / Text when Twilio is on)
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { phoneCopy, showingCopy, useKeepCopy } from './OfflineCache.js';

const STATUS_COPY = 'texting-status';
const QUEUE_COPY = 'texting-queue';

// The phone's copy is a stand-in for no signal only: it counts as old, so a
// screen with signal always asks the server first (new replies, quiet hours).
const standIn = (me, name) => ({ ...phoneCopy(me, name), initialDataUpdatedAt: 0 });

export function useTextingStatus(me) {
  const q = useQuery({
    queryKey: ['texting', 'status'],
    queryFn: () => apiGet('/texting/status'),
    staleTime: 15_000,
    refetchInterval: 30_000,
    ...standIn(me, STATUS_COPY),
  });
  useKeepCopy(me, STATUS_COPY, q);
  return q;
}

const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;
export const statusOffline = (q) => offlineNow() || showingCopy(q) || (!q.data && q.isError && !q.error?.status)
  || (!q.data && q.fetchStatus === 'paused');

export function useOnline() {
  const [online, setOnline] = useState(() => !offlineNow());
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

// The server answered with an error (no texting on this server): off, not unknown.
export const textingOn = (q) => {
  if (q.data) return { sms: Boolean(q.data.sms), voice: Boolean(q.data.voice) };
  if (q.isError && q.error?.status) return { sms: false, voice: false };
  return { sms: null, voice: null };
};

export function useTextQueue(me, on) {
  const q = useQuery({
    queryKey: ['texting', 'queue'],
    queryFn: () => apiGet('/texting/queue'),
    enabled: Boolean(on),
    staleTime: 10_000,
    refetchInterval: on ? 30_000 : false,
    ...standIn(me, QUEUE_COPY),
  });
  useKeepCopy(me, QUEUE_COPY, q);
  return q;
}

export const useTextingPerson = (personId, on = true) => useQuery({
  queryKey: ['texting', 'person', personId],
  queryFn: () => apiGet(`/texting/people/${personId}`),
  enabled: Boolean(personId) && Boolean(on),
  staleTime: 10_000,
});

export const callsCard = (person, channel) =>
  `/calls?${new URLSearchParams({ channel, q: person.name || '', person: person.id })}`;
