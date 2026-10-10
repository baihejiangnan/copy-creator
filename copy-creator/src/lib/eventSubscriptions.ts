/** Also releases listeners whose registration finishes after effect cleanup. */
export function ownEventSubscriptions(subscriptions: Promise<() => void>[], onError: (error: unknown) => void) {
  let disposed = false;
  const stops: (() => void)[] = [];
  subscriptions.forEach(subscription => { void subscription.then(stop => { if (disposed) stop(); else stops.push(stop); }).catch(onError); });
  return () => { disposed = true; stops.splice(0).forEach(stop => stop()); };
}
