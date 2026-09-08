// The scheduler container identifies itself so a run's metadata records whether
// it was scheduled or triggered by hand. Authorization is the bearer token; the
// user agent is only a label and grants nothing.
export const SCHEDULER_USER_AGENT = 'auckland-bargain-scheduler/1.0';

export function isAuthorizedCronRequest(
  request: Request,
  secret = process.env.CRON_SECRET,
) {
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export function collectionTrigger(request: Request) {
  return request.headers.get('user-agent') === SCHEDULER_USER_AGENT
    ? ('scheduler' as const)
    : ('manual' as const);
}
