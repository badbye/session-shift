// config-mutation-queue.ts — Serialize mutations that update the shared
// Profile/Rule configuration. Both collections are replaced together during
// import, so Profile-only and Rule-only writes must use this same queue.

let mutationQueue: Promise<void> = Promise.resolve()

export function withConfigMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const operation = mutationQueue.catch(() => {}).then(mutation)
  mutationQueue = operation.then(() => undefined, () => undefined)
  return operation
}
