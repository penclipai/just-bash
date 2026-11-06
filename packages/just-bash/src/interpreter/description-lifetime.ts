import type { ExecutionScope } from "../execution-scope.js";
import { BrokenPipeError } from "./byte-pipe.js";

interface Lifetime {
  references: number;
  closed: boolean;
  close: () => Promise<void>;
  scope: ExecutionScope;
}
const lifetimes = new WeakMap<object, Lifetime>();
const closing = new WeakMap<ExecutionScope, Set<Promise<void>>>();

export function registerDescriptionLifetime(
  endpoint: object,
  scope: ExecutionScope,
  close: () => Promise<void>,
): void {
  lifetimes.set(endpoint, { references: 0, closed: false, close, scope });
}

export function retainDescription(endpoint: object | undefined): boolean {
  const lifetime = endpoint && lifetimes.get(endpoint);
  if (!lifetime) return false;
  if (lifetime.closed) throw new BrokenPipeError();
  lifetime.references++;
  return true;
}

export function releaseDescription(endpoint: object | undefined): void {
  const lifetime = endpoint && lifetimes.get(endpoint);
  if (!lifetime || lifetime.closed) return;
  lifetime.references--;
  if (lifetime.references) return;
  lifetime.closed = true;
  let pending = closing.get(lifetime.scope);
  if (!pending) {
    pending = new Set();
    closing.set(lifetime.scope, pending);
  }
  const task = lifetime.close();
  pending.add(task);
  task.then(
    () => pending.delete(task),
    () => pending.delete(task),
  );
}

export function descriptionClosed(endpoint: object): boolean {
  return lifetimes.get(endpoint)?.closed ?? false;
}

export async function drainDescriptions(scope: ExecutionScope): Promise<void> {
  while (closing.get(scope)?.size)
    await Promise.allSettled([...(closing.get(scope) ?? [])]);
}
