// The one organization this Starbase runs for. The pilot is Imagine Surrey
// only: the first sign-up sets up its workspace, everyone after joins by
// invite. (Workspaces are still scoped by id underneath — tests and dev can
// open sign-up again with STARBASE_OPEN_SIGNUP=1.)
export const ORG_NAME = 'Imagine Surrey';
export const ORG_JURISDICTION = 'bc-municipal';

// Sign-up past first run: only when this is set (tests, local dev).
export const openSignupForced = () => process.env.STARBASE_OPEN_SIGNUP === '1';

export const SETUP_CLOSED_MESSAGE = 'Starbase is already set up for Imagine Surrey — ask a manager to invite you.';
