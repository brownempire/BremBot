export type PushSubscriptionRecord = PushSubscriptionJSON & { id: string };

const subscriptions: PushSubscriptionRecord[] = [];

export function addSubscription(sub: PushSubscriptionJSON) {
  const id = sub.endpoint ?? String(Date.now());
  if (subscriptions.some((existing) => existing.endpoint === sub.endpoint)) {
    return subscriptions;
  }
  subscriptions.push({ ...sub, id });
  return subscriptions;
}

export function listSubscriptions() {
  return subscriptions;
}
